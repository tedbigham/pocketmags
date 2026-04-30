import { PDFDocument } from "pdf-lib";

const UUID_RE =
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

const QUALITY_LEVELS = ["extralow", "low", "mid", "high", "extrahigh"];
const QUALITY_RE = QUALITY_LEVELS.join("|");

const BIN_RE = new RegExp(`/(${QUALITY_RE})/\\d{4}\\.bin(?:\\?|$)`);

const PARALLEL_DOWNLOADS = 20;

let detectedJob = null;
let cancelRequested = false;

let taskStatus = {
    running: false,
    message: "",
    pages: 0
};

function setStatus(message, pages = taskStatus.pages) {
    taskStatus = {
        running: taskStatus.running,
        message,
        pages
    };
}

function clearBadge(tabId) {
    if (tabId >= 0) {
        browser.browserAction.setBadgeText({ tabId, text: "" });
    }
}

function markDetected(tabId) {
    if (tabId >= 0) {
        browser.browserAction.setBadgeText({ tabId, text: "PDF" });
        browser.browserAction.setBadgeBackgroundColor({ tabId, color: "#2a7" });
    }
}

function extractBaseUrl(url) {
    return url.substring(0, url.lastIndexOf("/") + 1);
}

function replaceQualityInBaseUrl(baseUrl, quality) {
    return baseUrl.replace(new RegExp(`/(${QUALITY_RE})/$`), `/${quality}/`);
}

function extractOutputName(url) {
    const matches = [...url.matchAll(UUID_RE)].map(m => m[0]);
    return matches.length ? matches[matches.length - 1] : "output";
}

function sanitizeFilenamePart(value) {
    return value
        .trim()
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 120);
}

async function getPageTitleParts(tabId) {
    if (tabId < 0) return null;

    try {
        const results = await browser.tabs.executeScript(tabId, {
            code: `
        (() => {
          const name = document.querySelector("#info_title_name")?.textContent?.trim() || "";
          const issue = document.querySelector("#info_issue_name")?.textContent?.trim() || "";
          return { name, issue };
        })();
      `
        });

        const parts = results?.[0];

        if (!parts?.name && !parts?.issue) {
            return null;
        }

        return {
            name: sanitizeFilenamePart(parts.name || ""),
            issue: sanitizeFilenamePart(parts.issue || "")
        };
    } catch (e) {
        console.warn("Could not read page title fields:", e);
        return null;
    }
}

async function capturePageTitlePartsWithRetry(tabId) {
    const delays = [0, 500, 1000, 2000, 4000];

    for (const delay of delays) {
        if (delay > 0) {
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        if (!detectedJob || detectedJob.tabId !== tabId) {
            return;
        }

        const parts = await getPageTitleParts(tabId);

        if (parts) {
            detectedJob.pageParts = parts;
            console.log("Captured page title parts:", parts);
            return;
        }
    }

    console.warn("Could not capture page title parts after retry.");
}

function formatHeader(bytes) {
    return Array.from(bytes.slice(0, 16))
        .map(b => b.toString(16).padStart(2, "0"))
        .join(" ");
}

function repairImageHeader(bytes) {
    if (bytes.length < 12) {
        throw new Error("File too small");
    }

    const fixed = new Uint8Array(bytes);

    if (
        fixed[2] === 0x46 &&
        fixed[3] === 0x46 &&
        fixed[8] === 0x57 &&
        fixed[9] === 0x45 &&
        fixed[10] === 0x42 &&
        fixed[11] === 0x50
    ) {
        fixed[0] = 0x52;
        fixed[1] = 0x49;
        fixed[2] = 0x46;
        fixed[3] = 0x46;

        const riffSize = fixed.length - 8;

        fixed[4] = riffSize & 0xff;
        fixed[5] = (riffSize >> 8) & 0xff;
        fixed[6] = (riffSize >> 16) & 0xff;
        fixed[7] = (riffSize >> 24) & 0xff;

        return {
            type: "webp",
            mimeType: "image/webp",
            bytes: fixed
        };
    }

    if (
        fixed[2] === 0xff &&
        fixed[3] === 0xe0 &&
        fixed[4] === 0x00 &&
        fixed[5] === 0x10 &&
        fixed[6] === 0x4a &&
        fixed[7] === 0x46 &&
        fixed[8] === 0x49 &&
        fixed[9] === 0x46
    ) {
        fixed[0] = 0xff;
        fixed[1] = 0xd8;

        return {
            type: "jpg",
            mimeType: "image/jpeg",
            bytes: fixed
        };
    }

    throw new Error(`unknown image header: ${formatHeader(fixed)}`);
}

async function imageBytesToJpegBytes(bytes, mimeType) {
    const blob = new Blob([bytes], { type: mimeType });
    const bitmap = await createImageBitmap(blob);

    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");

    ctx.drawImage(bitmap, 0, 0);

    const jpegBlob = await canvas.convertToBlob({
        type: "image/jpeg",
        quality: 0.95
    });

    bitmap.close?.();

    return {
        bytes: new Uint8Array(await jpegBlob.arrayBuffer()),
        width: canvas.width,
        height: canvas.height
    };
}

async function fetchAndProcessPage(index, downloadBaseUrl) {
    const filename = `${String(index).padStart(4, "0")}.bin`;
    const url = downloadBaseUrl + filename;

    setStatus(`Downloading ${filename}`, taskStatus.pages);

    const response = await fetch(url);

    if (!response.ok) {
        return {
            index,
            stop: true,
            reason: `HTTP ${response.status}`,
            filename
        };
    }

    const rawBytes = new Uint8Array(await response.arrayBuffer());

    if (!rawBytes.length) {
        return {
            index,
            stop: true,
            reason: "empty response",
            filename
        };
    }

    let repaired;

    try {
        repaired = repairImageHeader(rawBytes);
    } catch (e) {
        return {
            index,
            skip: true,
            reason: e.message,
            filename
        };
    }

    let jpeg;

    try {
        jpeg = await imageBytesToJpegBytes(repaired.bytes, repaired.mimeType);
    } catch (e) {
        return {
            index,
            skip: true,
            reason: `decode failed: ${e.message || String(e)}`,
            filename
        };
    }

    return {
        index,
        filename,
        jpeg
    };
}

function buildOutputFilename(selectedQuality) {
    const pageParts = detectedJob?.pageParts;

    const baseFilename = pageParts
        ? `${pageParts.name} - ${pageParts.issue}`.replace(/ - $/, "").trim()
        : detectedJob.outputName;

    return `${baseFilename}_${selectedQuality}.pdf`;
}

async function runPdfDownload(selectedQuality) {
    if (!detectedJob) throw new Error("No matching URL detected yet.");

    taskStatus = {
        running: true,
        message: "Starting...",
        pages: 0
    };

    cancelRequested = false;

    const downloadBaseUrl = replaceQualityInBaseUrl(
        detectedJob.baseUrl,
        selectedQuality
    );

    const outputFilename = buildOutputFilename(selectedQuality);

    const pdfDoc = await PDFDocument.create();
    let pageCount = 0;
    let nextIndex = 0;
    let shouldStop = false;

    while (!shouldStop) {
        if (cancelRequested) {
            taskStatus = {
                running: false,
                message: `Cancelled after ${pageCount} pages.`,
                pages: pageCount
            };
            cancelRequested = false;
            return;
        }

        const batchIndexes = [];

        for (let n = 0; n < PARALLEL_DOWNLOADS; n++) {
            batchIndexes.push(nextIndex + n);
        }

        const results = await Promise.all(
            batchIndexes.map(index => fetchAndProcessPage(index, downloadBaseUrl))
        );

        results.sort((a, b) => a.index - b.index);

        for (const result of results) {
            if (cancelRequested) {
                taskStatus = {
                    running: false,
                    message: `Cancelled after ${pageCount} pages.`,
                    pages: pageCount
                };
                cancelRequested = false;
                return;
            }

            if (result.stop) {
                setStatus(`Stopping at ${result.filename}: ${result.reason}`, pageCount);
                shouldStop = true;
                break;
            }

            if (result.skip) {
                setStatus(`Skipping ${result.filename}: ${result.reason}`, pageCount);
                continue;
            }

            const embedded = await pdfDoc.embedJpg(result.jpeg.bytes);

            const page = pdfDoc.addPage([result.jpeg.width, result.jpeg.height]);
            page.drawImage(embedded, {
                x: 0,
                y: 0,
                width: result.jpeg.width,
                height: result.jpeg.height
            });

            pageCount++;
            setStatus(`Added page ${pageCount}`, pageCount);
        }

        nextIndex += PARALLEL_DOWNLOADS;
    }

    if (pageCount === 0) {
        throw new Error("No valid pages found.");
    }

    setStatus(`Saving ${outputFilename}...`, pageCount);

    const pdfBytes = await pdfDoc.save();
    const pdfBlob = new Blob([pdfBytes], { type: "application/pdf" });
    const objectUrl = URL.createObjectURL(pdfBlob);

    await browser.downloads.download({
        url: objectUrl,
        filename: outputFilename,
        saveAs: false,
        conflictAction: "uniquify"
    });

    setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
    }, 60_000);

    taskStatus = {
        running: false,
        message: `Saved ${outputFilename} with ${pageCount} pages.`,
        pages: pageCount
    };
}

browser.webRequest.onCompleted.addListener(
    details => {
        // Ignore extension/background fetches. Otherwise our own downloads overwrite
        // the page-based detectedJob and lose DOM-readable title metadata.
        if (details.tabId < 0) return;

        const match = details.url.match(BIN_RE);
        if (!match) return;

        detectedJob = {
            tabId: details.tabId,
            sampleUrl: details.url,
            baseUrl: extractBaseUrl(details.url),
            outputName: extractOutputName(details.url),
            detectedQuality: match[1],
            pageParts: null
        };

        markDetected(details.tabId);
        capturePageTitlePartsWithRetry(details.tabId);

        console.log("Detected magazine source:", detectedJob);
    },
    { urls: ["<all_urls>"] }
);

browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status !== "loading") return;

    clearBadge(tabId);

    if (detectedJob?.tabId === tabId) {
        detectedJob = null;
    }
});

browser.tabs.onRemoved.addListener(tabId => {
    if (detectedJob?.tabId === tabId) {
        detectedJob = null;
    }
});

browser.runtime.onMessage.addListener(message => {
    if (message?.type === "getDetectedJob") {
        return Promise.resolve(detectedJob);
    }

    if (message?.type === "getStatus") {
        return Promise.resolve(taskStatus);
    }

    if (message?.type === "cancelPdfDownload") {
        cancelRequested = true;
        return Promise.resolve({ ok: true });
    }

    if (message?.type === "startPdfDownload") {
        if (taskStatus.running) {
            return Promise.resolve({
                ok: false,
                error: "Download already running."
            });
        }

        const quality = QUALITY_LEVELS.includes(message.quality)
            ? message.quality
            : "extrahigh";

        browser.storage.local.set({ quality });

        runPdfDownload(quality).catch(e => {
            taskStatus = {
                running: false,
                message: `Error: ${e.message || String(e)}`,
                pages: taskStatus.pages
            };
        });

        return Promise.resolve({ ok: true });
    }

    return Promise.resolve(null);
});
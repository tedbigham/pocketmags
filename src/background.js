import { PDFDocument } from "pdf-lib";

const UUID_RE =
    /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/g;

const BIN_RE = /\/extrahigh\/\d{4}\.bin(?:\?|$)/;

const PARALLEL_DOWNLOADS = 20;

let detectedJob = null;
let cancelRequested = false;

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

function extractOutputName(url) {
    const matches = [...url.matchAll(UUID_RE)].map(m => m[0]);
    return matches.length ? matches[matches.length - 1] : "output";
}

function fixWebpHeader(bytes) {
    if (bytes.length < 12) throw new Error("File too small");

    const fixed = new Uint8Array(bytes);

    fixed[0] = 0x52;
    fixed[1] = 0x49;
    fixed[2] = 0x46;
    fixed[3] = 0x46;

    const riffSize = fixed.length - 8;

    fixed[4] = riffSize & 0xff;
    fixed[5] = (riffSize >> 8) & 0xff;
    fixed[6] = (riffSize >> 16) & 0xff;
    fixed[7] = (riffSize >> 24) & 0xff;

    return fixed;
}

async function fixedWebpToJpegBytes(fixedWebpBytes) {
    const webpBlob = new Blob([fixedWebpBytes], { type: "image/webp" });
    const bitmap = await createImageBitmap(webpBlob);

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

async function fetchAndProcessPage(index, reportProgress) {
    const filename = `${String(index).padStart(4, "0")}.bin`;
    const url = detectedJob.baseUrl + filename;

    reportProgress({
        phase: "downloading",
        current: index + 1,
        filename
    });

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

    let fixedWebp;

    try {
        fixedWebp = fixWebpHeader(rawBytes);
    } catch (e) {
        return {
            index,
            skip: true,
            reason: e.message,
            filename
        };
    }

    if (
        fixedWebp[8] !== 0x57 ||
        fixedWebp[9] !== 0x45 ||
        fixedWebp[10] !== 0x42 ||
        fixedWebp[11] !== 0x50
    ) {
        return {
            index,
            skip: true,
            reason: "missing WEBP marker",
            filename
        };
    }

    const jpeg = await fixedWebpToJpegBytes(fixedWebp);

    return {
        index,
        filename,
        jpeg
    };
}

async function buildPdfFromDetectedJob(reportProgress) {
    if (!detectedJob) throw new Error("No matching URL detected yet.");

    const pdfDoc = await PDFDocument.create();
    let pageCount = 0;
    let nextIndex = 0;
    let shouldStop = false;

    while (!shouldStop) {
        if (cancelRequested) {
            cancelRequested = false;
            reportProgress({ phase: "cancelled", pages: pageCount });
            return { pages: pageCount, cancelled: true };
        }

        const batchStart = nextIndex;
        const batchIndexes = [];

        for (let n = 0; n < PARALLEL_DOWNLOADS; n++) {
            batchIndexes.push(batchStart + n);
        }

        const results = await Promise.all(
            batchIndexes.map(index => fetchAndProcessPage(index, reportProgress))
        );

        results.sort((a, b) => a.index - b.index);

        for (const result of results) {
            if (cancelRequested) {
                cancelRequested = false;
                reportProgress({ phase: "cancelled", pages: pageCount });
                return { pages: pageCount, cancelled: true };
            }

            if (result.stop) {
                reportProgress({
                    phase: "stopping",
                    reason: result.reason,
                    filename: result.filename,
                    pages: pageCount
                });

                shouldStop = true;
                break;
            }

            if (result.skip) {
                reportProgress({
                    phase: "skipping",
                    filename: result.filename,
                    reason: result.reason,
                    pages: pageCount
                });

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
        }

        nextIndex += PARALLEL_DOWNLOADS;
    }

    if (pageCount === 0) throw new Error("No valid pages found.");

    reportProgress({ phase: "saving", pages: pageCount });

    const pdfBytes = await pdfDoc.save();
    const pdfBlob = new Blob([pdfBytes], { type: "application/pdf" });
    const objectUrl = URL.createObjectURL(pdfBlob);

    await browser.downloads.download({
        url: objectUrl,
        filename: `${detectedJob.outputName}.pdf`,
        saveAs: true
    });

    return { pages: pageCount, cancelled: false };
}

browser.webRequest.onCompleted.addListener(
    details => {
        if (!BIN_RE.test(details.url)) return;

        detectedJob = {
            tabId: details.tabId,
            sampleUrl: details.url,
            baseUrl: extractBaseUrl(details.url),
            outputName: extractOutputName(details.url)
        };

        markDetected(details.tabId);

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

browser.runtime.onMessage.addListener(async message => {
    if (message?.type === "getDetectedJob") return detectedJob;
    return null;
});

browser.runtime.onConnect.addListener(port => {
    if (port.name !== "pdf-download") return;

    port.onMessage.addListener(async message => {
        if (message?.type === "cancel") {
            cancelRequested = true;
            return;
        }

        if (message?.type !== "downloadPdf") return;

        cancelRequested = false;

        try {
            const result = await buildPdfFromDetectedJob(progress => {
                port.postMessage({
                    type: "progress",
                    ...progress
                });
            });

            if (result.cancelled) {
                port.postMessage({
                    type: "cancelled",
                    pages: result.pages
                });
            } else {
                port.postMessage({
                    type: "complete",
                    pages: result.pages
                });
            }
        } catch (e) {
            port.postMessage({
                type: "error",
                message: e.message || String(e)
            });
        }
    });
});
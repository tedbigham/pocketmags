const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");
const qualitySelect = document.getElementById("quality");

let running = false;
let pollTimer = null;

function formatDetectedName(job) {
    if (job?.pageParts) {
        const name = job.pageParts.name || "";
        const issue = job.pageParts.issue || "";
        return `${name} - ${issue}`.replace(/ - $/, "").trim();
    }

    return job?.outputName || "";
}

async function loadQuality() {
    const stored = await browser.storage.local.get({ quality: "extrahigh" });
    qualitySelect.value = stored.quality;
}

async function refresh() {
    const status = await browser.runtime.sendMessage({ type: "getStatus" });
    const job = await browser.runtime.sendMessage({ type: "getDetectedJob" });

    if (status?.running) {
        running = true;
        downloadBtn.textContent = "Cancel";
        downloadBtn.disabled = false;
        statusEl.textContent = status.message || "Running...";
        startPolling();
        return;
    }

    running = false;
    downloadBtn.textContent = "Download PDF";

    if (!job) {
        statusEl.textContent = "No matching .bin request detected yet.";
        downloadBtn.disabled = true;
        return;
    }

    const displayName = formatDetectedName(job);

    statusEl.textContent = displayName
        ? `Detected: ${displayName}`
        : "Detected";

    downloadBtn.disabled = false;
}

function startPolling() {
    if (pollTimer) return;

    pollTimer = setInterval(async () => {
        const status = await browser.runtime.sendMessage({ type: "getStatus" });

        if (!status?.running) {
            clearInterval(pollTimer);
            pollTimer = null;

            running = false;
            downloadBtn.textContent = "Download PDF";
            downloadBtn.disabled = false;

            if (status?.message) {
                statusEl.textContent = status.message;
            }

            return;
        }

        statusEl.textContent = status.message || "Running...";
    }, 500);
}

qualitySelect.addEventListener("change", async () => {
    await browser.storage.local.set({
        quality: qualitySelect.value
    });
});

downloadBtn.addEventListener("click", async () => {
    if (running) {
        statusEl.textContent = "Cancelling...";
        downloadBtn.disabled = true;

        await browser.runtime.sendMessage({ type: "cancelPdfDownload" });
        return;
    }

    await browser.storage.local.set({
        quality: qualitySelect.value
    });

    const result = await browser.runtime.sendMessage({
        type: "startPdfDownload",
        quality: qualitySelect.value
    });

    if (!result?.ok) {
        statusEl.textContent = result?.error || "Could not start download.";
        return;
    }

    running = true;
    downloadBtn.textContent = "Cancel";
    downloadBtn.disabled = false;
    statusEl.textContent = "Starting...";

    startPolling();
});

(async () => {
    await loadQuality();
    await refresh();
})();

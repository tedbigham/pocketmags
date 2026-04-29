const statusEl = document.getElementById("status");
const downloadBtn = document.getElementById("download");

let running = false;
let port = null;

async function refresh() {
    const job = await browser.runtime.sendMessage({ type: "getDetectedJob" });

    if (!job) {
        statusEl.textContent = "No matching .bin request detected yet.";
        downloadBtn.disabled = true;
        return;
    }

    statusEl.textContent = `Detected: ${job.outputName}`;
    downloadBtn.disabled = false;
}

function resetButton() {
    running = false;
    downloadBtn.textContent = "Download PDF";
    downloadBtn.disabled = false;

    if (port) {
        port.disconnect();
        port = null;
    }
}

downloadBtn.addEventListener("click", () => {
    if (running) {
        statusEl.textContent = "Cancelling...";
        downloadBtn.disabled = true;
        port?.postMessage({ type: "cancel" });
        return;
    }

    running = true;
    downloadBtn.textContent = "Cancel";
    downloadBtn.disabled = false;
    statusEl.textContent = "Starting...";

    port = browser.runtime.connect({ name: "pdf-download" });

    port.onMessage.addListener(message => {
        if (message.type === "progress") {
            if (message.phase === "downloading") {
                statusEl.textContent = `Downloading (page: ${message.current})`;
            }

            if (message.phase === "skipping") {
                statusEl.textContent = `Skipping ${message.filename}: ${message.reason}`;
            }

            if (message.phase === "stopping") {
                statusEl.textContent = `Stopping at ${message.filename}: ${message.reason}`;
            }

            if (message.phase === "saving") {
                statusEl.textContent = `Saving PDF with ${message.pages} pages...`;
            }

            if (message.phase === "cancelled") {
                statusEl.textContent = `Cancelled after ${message.pages} pages.`;
            }
        }

        if (message.type === "complete") {
            statusEl.textContent = `Saved PDF with ${message.pages} pages.`;
            resetButton();
        }

        if (message.type === "cancelled") {
            statusEl.textContent = `Cancelled after ${message.pages} pages.`;
            resetButton();
        }

        if (message.type === "error") {
            statusEl.textContent = `Error: ${message.message}`;
            resetButton();
        }
    });

    port.postMessage({ type: "downloadPdf" });
});

refresh();
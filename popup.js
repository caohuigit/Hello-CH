const captureBtn = document.getElementById("captureBtn");
const statusEl = document.getElementById("status");
const progressBar = document.getElementById("progressBar");
const progressInner = document.getElementById("progressInner");

// Listen for progress updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === "captureProgress") {
    progressBar.classList.add("active");
    progressInner.style.width = ((msg.current / msg.total) * 100) + "%";
    statusEl.textContent = "\u6B63\u5728\u622A\u53D6 " + msg.current + "/" + msg.total + " \u5C4F...";
  }
});

captureBtn.addEventListener("click", async () => {
  captureBtn.disabled = true;
  statusEl.textContent = "\u6B63\u5728\u51C6\u5907\u622A\u56FE...";
  progressBar.classList.add("active");
  progressInner.style.width = "0%";

  try {
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });

    const response = await chrome.runtime.sendMessage({
      action: "startCapture",
      tabId: tab.id,
    });

    if (response && response.success) {
      statusEl.textContent = "\u622A\u56FE\u5B8C\u6210\uFF01\u6B63\u5728\u6253\u5F00\u9884\u89C8...";
      progressInner.style.width = "100%";
      // Popup will close when preview tab opens
    } else {
      statusEl.textContent = "\u51FA\u9519\u4E86: " + (response ? response.error : "\u672A\u77E5\u9519\u8BEF");
      captureBtn.disabled = false;
      progressBar.classList.remove("active");
    }
  } catch (err) {
    statusEl.textContent = "\u51FA\u9519\u4E86: " + err.message;
    captureBtn.disabled = false;
    progressBar.classList.remove("active");
  }
});

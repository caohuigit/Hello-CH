// Store captured data for preview page to retrieve
let capturedData = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "startCapture") {
    captureFullPage(message.tabId)
      .then(() => {
        sendResponse({ success: true });
      })
      .catch((err) => {
        console.error("Capture failed:", err);
        sendResponse({ success: false, error: err.message });
      });
    return true; // keep channel open for async response
  }

  if (message.action === "getCaptureInfo") {
    if (!capturedData) {
      sendResponse(null);
    } else {
      sendResponse({
        count: capturedData.screenshots.length,
        pageInfo: capturedData.pageInfo,
        title: capturedData.title,
      });
    }
    return;
  }

  if (message.action === "getScreenshot") {
    if (!capturedData || message.index >= capturedData.screenshots.length) {
      sendResponse(null);
    } else {
      sendResponse(capturedData.screenshots[message.index]);
    }
    return;
  }
});

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureFullPage(tabId) {
  // Step 1: Inject style overrides and measure page
  // - Force scroll-behavior: auto so scrollTo jumps instantly
  // - Temporarily remove overflow: hidden on html/body that hides content
  const [{ result: pageInfo }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      // Inject style to disable smooth scrolling globally
      let styleEl = document.getElementById("__scroll_capture_style__");
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = "__scroll_capture_style__";
        document.head.appendChild(styleEl);
      }
      styleEl.textContent =
        "html, body, * { scroll-behavior: auto !important; }";

      // Some sites set overflow:hidden on html/body, preventing scroll
      // and causing scrollHeight === clientHeight. Temporarily override.
      const html = document.documentElement;
      const body = document.body;
      const htmlOverflow = html.style.overflow;
      const bodyOverflow = body.style.overflow;
      html.style.setProperty("overflow", "visible", "important");
      body.style.setProperty("overflow", "visible", "important");

      // Force layout recalc
      void html.offsetHeight;

      const scrollHeight = Math.max(
        html.scrollHeight,
        body.scrollHeight,
        html.offsetHeight,
        body.offsetHeight
      );

      // Restore overflow (the page still needs to scroll normally)
      html.style.overflow = htmlOverflow;
      body.style.overflow = bodyOverflow;

      // Scroll to top
      window.scrollTo(0, 0);

      return {
        scrollHeight: scrollHeight,
        viewportHeight: window.innerHeight,
        viewportWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio || 1,
      };
    },
  });

  const tab = await chrome.tabs.get(tabId);
  const title = tab.title || "screenshot";

  const { viewportHeight, viewportWidth, devicePixelRatio } = pageInfo;
  let scrollHeight = pageInfo.scrollHeight;
  let totalSteps = Math.ceil(scrollHeight / viewportHeight);
  const screenshots = [];

  // Wait for scroll-to-top to render
  await delay(500);

  for (let i = 0; i < totalSteps; i++) {
    const targetScrollY = i * viewportHeight;

    // --- SCROLL ---
    // Use simple synchronous scroll (no Promise/rAF tricks that may be flaky).
    // The injected CSS ensures scroll-behavior is 'auto', so scrollTo is instant.
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (y) => {
        // Belt and suspenders: set scrollTop on both html and body,
        // plus window.scrollTo, to cover all page configurations.
        window.scrollTo(0, y);
        document.documentElement.scrollTop = y;
        document.body.scrollTop = y; // for quirks mode / WebKit
      },
      args: [targetScrollY],
    });

    // --- WAIT FOR REPAINT ---
    // Generous fixed delay; the CSS override guarantees the scroll is instant,
    // so this only needs to cover repaint + lazy image loading.
    await delay(600);

    // --- VERIFY SCROLL POSITION + RE-MEASURE HEIGHT ---
    const [{ result: scrollState }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        // Re-measure height (content may have grown from lazy loading)
        const html = document.documentElement;
        const body = document.body;
        const htmlOv = html.style.overflow;
        const bodyOv = body.style.overflow;
        html.style.setProperty("overflow", "visible", "important");
        body.style.setProperty("overflow", "visible", "important");
        void html.offsetHeight;
        const h = Math.max(
          html.scrollHeight,
          body.scrollHeight,
          html.offsetHeight,
          body.offsetHeight
        );
        html.style.overflow = htmlOv;
        body.style.overflow = bodyOv;

        return {
          scrollY: window.scrollY || document.documentElement.scrollTop,
          scrollHeight: h,
        };
      },
    });

    // If page grew (lazy loading / infinite scroll), update totalSteps
    if (scrollState.scrollHeight > scrollHeight) {
      scrollHeight = scrollState.scrollHeight;
      totalSteps = Math.ceil(scrollHeight / viewportHeight);
    }

    // If scroll didn't reach target, retry with a different method
    if (
      i > 0 &&
      Math.abs(scrollState.scrollY - targetScrollY) > 5 &&
      targetScrollY <= scrollHeight - viewportHeight
    ) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (y) => {
          document.documentElement.scrollTop = y;
          document.body.scrollTop = y;
          window.scrollTo(0, y);
        },
        args: [targetScrollY],
      });
      await delay(600);
    }

    // --- CAPTURE ---
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png",
    });

    // Small delay between capture and next scroll to avoid pipeline stalls
    await delay(100);

    // --- EXTRACT TEXT for dual-layer PDF ---
    let textData = [];
    try {
      const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const results = [];
          const vh = window.innerHeight;
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_TEXT,
            {
              acceptNode(node) {
                const t = node.textContent.trim();
                if (!t) return NodeFilter.FILTER_REJECT;
                const el = node.parentElement;
                if (!el) return NodeFilter.FILTER_REJECT;
                const s = getComputedStyle(el);
                if (
                  s.display === "none" ||
                  s.visibility === "hidden" ||
                  s.opacity === "0"
                )
                  return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
              },
            }
          );

          while (walker.nextNode()) {
            const node = walker.currentNode;
            const text = node.textContent.trim();
            if (!text) continue;

            const range = document.createRange();
            range.selectNodeContents(node);
            const rects = range.getClientRects();
            if (rects.length === 0) continue;

            const el = node.parentElement;
            const fontSize = parseFloat(getComputedStyle(el).fontSize);

            for (const rect of rects) {
              if (rect.width < 1 || rect.height < 1) continue;
              if (rect.bottom < 0 || rect.top > vh) continue;

              const charPerRect = Math.max(
                1,
                Math.round(text.length / rects.length)
              );
              const rectIndex = Array.from(rects).indexOf(rect);
              const lineText = text.substring(
                rectIndex * charPerRect,
                (rectIndex + 1) * charPerRect
              );

              results.push({
                text: lineText || text,
                x: rect.left,
                y: rect.top,
                width: rect.width,
                height: rect.height,
                fontSize: fontSize,
              });
            }
          }
          return results;
        },
      });
      textData = result || [];
    } catch (e) {
      console.warn("Text extraction failed for step", i, e);
    }

    // --- CROP INFO for last screenshot ---
    const isLast = i === totalSteps - 1;
    let cropInfo = null;

    if (isLast && totalSteps > 1) {
      const maxScrollY = scrollHeight - viewportHeight;
      if (targetScrollY > maxScrollY) {
        const overlap = targetScrollY - maxScrollY;
        cropInfo = {
          yOffset: overlap * devicePixelRatio,
          height: (viewportHeight - overlap) * devicePixelRatio,
        };
      }
    }

    screenshots.push({
      dataUrl,
      textData,
      cropInfo,
      viewportWidth: viewportWidth * devicePixelRatio,
      viewportHeight: viewportHeight * devicePixelRatio,
    });

    // Send progress to popup (if still open)
    try {
      chrome.runtime.sendMessage({
        action: "captureProgress",
        current: i + 1,
        total: totalSteps,
      });
    } catch (e) {
      // Popup may be closed, ignore
    }
  }

  // Clean up: remove injected style, scroll back to top
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const s = document.getElementById("__scroll_capture_style__");
      if (s) s.remove();
      window.scrollTo(0, 0);
    },
  });

  // Store captured data
  capturedData = {
    screenshots,
    pageInfo: {
      scrollHeight,
      viewportHeight,
      viewportWidth,
      devicePixelRatio,
    },
    title,
  };

  // Open preview page in new tab
  chrome.tabs.create({
    url: chrome.runtime.getURL("preview.html"),
  });
}

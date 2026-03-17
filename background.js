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
  // ---------------------------------------------------------------
  // STEP 1: Detect the real scrollable container.
  //
  //   Modern SPAs typically use:
  //     html/body { overflow: hidden; height: 100vh }
  //     div.main-content { overflow-y: auto; height: 100vh }
  //
  //   In that case, window.scrollTo does nothing — we must find
  //   and scroll the actual container element.
  //
  //   Strategy:
  //     1) Check if the document itself is scrollable
  //     2) If not, scan for the element with the largest scrollable area
  //     3) Mark it with a data attribute so later executeScript calls
  //        can find it again (we can't hold DOM refs across calls)
  // ---------------------------------------------------------------
  const [{ result: setupResult }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const html = document.documentElement;
      const body = document.body;
      const MARKER = "__scroll_capture_target__";

      // --- Detect whether the document is natively scrollable ---
      const docScrollable = html.scrollHeight > window.innerHeight + 20;

      let useDocScroll = docScrollable;
      let containerScrollHeight = 0;
      let containerClientHeight = 0;

      if (!docScrollable) {
        // --- Find the real scrollable container ---
        // Look for the element with overflow-y: auto|scroll AND the
        // largest scrollable distance (scrollHeight - clientHeight).
        let best = null;
        let bestScrollable = 0;

        const all = document.querySelectorAll("*");
        for (let i = 0; i < all.length; i++) {
          const el = all[i];
          if (el.scrollHeight <= el.clientHeight + 10) continue;

          const style = getComputedStyle(el);
          const ov = style.overflowY;
          if (ov !== "auto" && ov !== "scroll") continue;

          // Must be a reasonably sized container (> 40% viewport height)
          if (el.clientHeight < window.innerHeight * 0.4) continue;

          const scrollable = el.scrollHeight - el.clientHeight;
          if (scrollable > bestScrollable) {
            bestScrollable = scrollable;
            best = el;
          }
        }

        if (best) {
          best.setAttribute("data-" + MARKER, "true");
          best.style.setProperty("scroll-behavior", "auto", "important");
          containerScrollHeight = best.scrollHeight;
          containerClientHeight = best.clientHeight;
          useDocScroll = false;
        } else {
          // No scrollable container found — fallback to forcing doc scroll
          useDocScroll = true;
        }
      }

      // Save original inline styles for restoration
      const saved = {
        htmlOverflow: html.style.overflow,
        htmlOverflowY: html.style.overflowY,
        bodyOverflow: body.style.overflow,
        bodyOverflowY: body.style.overflowY,
        htmlHeight: html.style.height,
        bodyHeight: body.style.height,
      };

      // Inject CSS overrides
      let styleEl = document.getElementById("__scroll_capture_style__");
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = "__scroll_capture_style__";
        document.head.appendChild(styleEl);
      }

      if (useDocScroll) {
        // Force document to be scrollable
        styleEl.textContent = [
          "html, body {",
          "  overflow-y: auto !important;",
          "  overflow-x: hidden !important;",
          "  scroll-behavior: auto !important;",
          "  height: auto !important;",
          "  min-height: 100vh !important;",
          "}",
          "* { scroll-behavior: auto !important; }",
        ].join("\n");
      } else {
        // Only override scroll-behavior; don't touch overflow
        // (the container already scrolls, we don't want to break layout)
        styleEl.textContent = "* { scroll-behavior: auto !important; }";
      }

      return {
        saved: saved,
        useDocScroll: useDocScroll,
        containerScrollHeight: containerScrollHeight,
        containerClientHeight: containerClientHeight,
      };
    },
  });

  const { useDocScroll } = setupResult;

  // Let CSS overrides take effect
  await delay(500);

  // ---------------------------------------------------------------
  // STEP 2: Measure page dimensions
  // ---------------------------------------------------------------
  const [{ result: pageInfo }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: (isDocScroll) => {
      const MARKER = "__scroll_capture_target__";
      const html = document.documentElement;
      const body = document.body;

      if (isDocScroll) {
        // Measure the document
        let maxHeight = Math.max(
          html.scrollHeight,
          html.offsetHeight,
          body.scrollHeight,
          body.offsetHeight
        );
        // Scan top-level children as fallback
        for (let i = 0; i < body.children.length; i++) {
          const rect = body.children[i].getBoundingClientRect();
          const bottom = rect.bottom + window.scrollY;
          if (bottom > maxHeight) maxHeight = bottom;
        }
        // Scroll to top
        window.scrollTo(0, 0);

        return {
          scrollHeight: Math.ceil(maxHeight),
          stepHeight: window.innerHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        };
      } else {
        // Measure the container
        const container = document.querySelector(
          "[data-" + MARKER + "]"
        );
        if (!container) {
          throw new Error("Scroll container lost");
        }
        container.scrollTop = 0;

        return {
          scrollHeight: container.scrollHeight,
          // stepHeight = the visible height of the container per screenshot
          stepHeight: container.clientHeight,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
        };
      }
    },
    args: [useDocScroll],
  });

  const tab = await chrome.tabs.get(tabId);
  const title = tab.title || "screenshot";

  const { viewportWidth, viewportHeight, devicePixelRatio } = pageInfo;
  // stepHeight: how many CSS px of content we advance per step
  const stepHeight = pageInfo.stepHeight;
  let scrollHeight = pageInfo.scrollHeight;
  let totalSteps = Math.ceil(scrollHeight / stepHeight);
  const screenshots = [];

  // ---------------------------------------------------------------
  // STEP 3: Capture loop
  // ---------------------------------------------------------------
  for (let i = 0; i < totalSteps; i++) {
    const targetScrollY = i * stepHeight;

    // --- SCROLL ---
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (y, isDocScroll) => {
        const MARKER = "__scroll_capture_target__";
        if (isDocScroll) {
          window.scrollTo(0, y);
          document.documentElement.scrollTop = y;
          document.body.scrollTop = y;
        } else {
          const container = document.querySelector(
            "[data-" + MARKER + "]"
          );
          if (container) container.scrollTop = y;
        }
      },
      args: [targetScrollY, useDocScroll],
    });

    // Wait for repaint
    await delay(600);

    // --- VERIFY + RE-MEASURE ---
    const [{ result: scrollState }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: (isDocScroll) => {
        const MARKER = "__scroll_capture_target__";
        if (isDocScroll) {
          const html = document.documentElement;
          const body = document.body;
          let h = Math.max(
            html.scrollHeight,
            html.offsetHeight,
            body.scrollHeight,
            body.offsetHeight
          );
          for (let i = 0; i < body.children.length; i++) {
            const rect = body.children[i].getBoundingClientRect();
            const bottom = rect.bottom + window.scrollY;
            if (bottom > h) h = bottom;
          }
          return {
            scrollY:
              window.scrollY || html.scrollTop || body.scrollTop,
            scrollHeight: Math.ceil(h),
          };
        } else {
          const container = document.querySelector(
            "[data-" + MARKER + "]"
          );
          if (!container) return { scrollY: 0, scrollHeight: 0 };
          return {
            scrollY: container.scrollTop,
            scrollHeight: container.scrollHeight,
          };
        }
      },
      args: [useDocScroll],
    });

    // Update if page grew (lazy loading)
    if (scrollState.scrollHeight > scrollHeight) {
      scrollHeight = scrollState.scrollHeight;
      totalSteps = Math.ceil(scrollHeight / stepHeight);
    }

    // If scroll didn't reach target, retry
    const maxScrollY = scrollHeight - stepHeight;
    if (
      i > 0 &&
      Math.abs(scrollState.scrollY - targetScrollY) > 5 &&
      targetScrollY <= maxScrollY
    ) {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (y, isDocScroll) => {
          const MARKER = "__scroll_capture_target__";
          if (isDocScroll) {
            document.documentElement.scrollTop = y;
            document.body.scrollTop = y;
            window.scrollTo(0, y);
          } else {
            const container = document.querySelector(
              "[data-" + MARKER + "]"
            );
            if (container) container.scrollTop = y;
          }
        },
        args: [targetScrollY, useDocScroll],
      });
      await delay(600);
    }

    // --- CAPTURE ---
    const dataUrl = await chrome.tabs.captureVisibleTab(null, {
      format: "png",
    });

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
    // When using a container, stepHeight may differ from viewportHeight.
    // captureVisibleTab always captures the full viewport (viewportHeight),
    // but we scroll by stepHeight per step. We need to crop based on
    // how the last step's scroll was clamped.
    const isLast = i === totalSteps - 1;
    let cropInfo = null;

    if (isLast && totalSteps > 1) {
      if (useDocScroll) {
        // Document scroll: overlap comes from scroll clamping
        const docMaxScroll = scrollHeight - viewportHeight;
        if (targetScrollY > docMaxScroll && docMaxScroll >= 0) {
          const overlap = targetScrollY - docMaxScroll;
          cropInfo = {
            yOffset: overlap * devicePixelRatio,
            height: (viewportHeight - overlap) * devicePixelRatio,
          };
        }
      } else {
        // Container scroll: the container might not fill the full viewport.
        // The visible portion of the last step = remainder of content.
        const remainder = scrollHeight - targetScrollY;
        if (remainder < stepHeight) {
          // The container showed 'remainder' px of new content at the bottom.
          // The top (stepHeight - remainder) px overlap with previous capture.
          // But captureVisibleTab captures the full viewport, not just the container.
          // We need to figure out where the container sits in the viewport.
          // For simplicity, we store the overlap relative to the full viewport.
          const overlap = stepHeight - remainder;
          cropInfo = {
            yOffset: overlap * devicePixelRatio,
            height: (viewportHeight - overlap) * devicePixelRatio,
          };
        }
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

  // ---------------------------------------------------------------
  // STEP 4: Cleanup
  // ---------------------------------------------------------------
  await chrome.scripting.executeScript({
    target: { tabId },
    func: (saved, isDocScroll) => {
      const MARKER = "__scroll_capture_target__";

      // Remove injected style
      const s = document.getElementById("__scroll_capture_style__");
      if (s) s.remove();

      // Remove container marker and restore its scroll-behavior
      const container = document.querySelector(
        "[data-" + MARKER + "]"
      );
      if (container) {
        container.removeAttribute("data-" + MARKER);
        container.style.removeProperty("scroll-behavior");
        container.scrollTop = 0;
      }

      // Restore original inline styles on html/body
      const html = document.documentElement;
      const body = document.body;
      html.style.overflow = saved.htmlOverflow;
      html.style.overflowY = saved.htmlOverflowY;
      html.style.height = saved.htmlHeight;
      body.style.overflow = saved.bodyOverflow;
      body.style.overflowY = saved.bodyOverflowY;
      body.style.height = saved.bodyHeight;

      if (isDocScroll) {
        window.scrollTo(0, 0);
      }
    },
    args: [setupResult.saved, useDocScroll],
  });

  // Store captured data
  capturedData = {
    screenshots,
    pageInfo: {
      scrollHeight,
      stepHeight,
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

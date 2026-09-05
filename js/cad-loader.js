(function () {
  "use strict";

  const PHONE_BREAKPOINT = "(max-width: 767px)";
  const MODEL_VIEWER_URL =
    "https://ajax.googleapis.com/ajax/libs/model-viewer/4.0.0/model-viewer.min.js";
  const phoneLayout = window.matchMedia(PHONE_BREAKPOINT);
  const pendingViewers = [];
  let libraryPromise;

  function loadModelViewerLibrary() {
    if (window.customElements?.get("model-viewer")) {
      return Promise.resolve();
    }

    if (libraryPromise) return libraryPromise;

    libraryPromise = new Promise(function (resolve, reject) {
      const script = document.createElement("script");
      script.type = "module";
      script.src = MODEL_VIEWER_URL;
      script.dataset.cadViewerLibrary = "true";
      script.addEventListener("load", resolve, { once: true });
      script.addEventListener(
        "error",
        function () {
          libraryPromise = null;
          script.remove();
          reject(new Error("The interactive CAD viewer could not be loaded."));
        },
        { once: true },
      );
      document.head.appendChild(script);
    });

    return libraryPromise;
  }

  async function activateViewer(item) {
    if (item.loaded || item.loading) return;

    item.loading = true;
    item.button.disabled = true;
    item.wrapper.classList.add("cad-is-loading");
    item.status.textContent = "Loading interactive CAD…";

    try {
      await loadModelViewerLibrary();
      await window.customElements.whenDefined("model-viewer");
      item.viewer.setAttribute("src", item.source);
      item.loaded = true;
      item.wrapper.classList.remove("cad-load-pending", "cad-is-loading");
      item.gate.remove();
    } catch (error) {
      item.loading = false;
      item.button.disabled = false;
      item.wrapper.classList.remove("cad-is-loading");
      item.status.textContent =
        "CAD could not be loaded. Check your connection and try again.";
    }
  }

  function holdViewerForConfirmation(wrapper, viewer) {
    const source = viewer.getAttribute("src");
    if (!source) return;

    viewer.removeAttribute("src");
    viewer.dataset.cadSrc = source;
    wrapper.classList.add("cad-load-pending");

    const gate = document.createElement("div");
    gate.className = "cad-load-gate";

    const status = document.createElement("p");
    status.className = "cad-load-status";
    status.setAttribute("aria-live", "polite");
    status.textContent =
      "Interactive CAD is paused to save mobile data and memory.";

    const button = document.createElement("button");
    button.className = "cad-load-button";
    button.type = "button";
    button.textContent = "Load interactive CAD";

    gate.append(status, button);
    wrapper.appendChild(gate);

    const item = {
      wrapper,
      viewer,
      gate,
      status,
      button,
      source,
      loading: false,
      loaded: false,
    };

    pendingViewers.push(item);
    button.addEventListener("click", function () {
      activateViewer(item);
    });
  }

  const viewerPairs = Array.from(
    document.querySelectorAll(".project-detail-model-viewer"),
  )
    .map(function (wrapper) {
      return {
        wrapper,
        viewer: wrapper.querySelector("model-viewer"),
      };
    })
    .filter(function (pair) {
      return pair.viewer;
    });

  if (!viewerPairs.length) return;

  if (phoneLayout.matches) {
    viewerPairs.forEach(function (pair) {
      holdViewerForConfirmation(pair.wrapper, pair.viewer);
    });
  } else {
    loadModelViewerLibrary().catch(function (error) {
      console.error(error);
    });
  }

  phoneLayout.addEventListener("change", function (event) {
    if (!event.matches) {
      pendingViewers.forEach(activateViewer);
    }
  });
})();

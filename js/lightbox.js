document.addEventListener("DOMContentLoaded", () => {
  /* =========================================
     CREATE GLOBAL LIGHTBOX
     ========================================= */

  const lightbox = document.createElement("div");
  lightbox.className = "image-lightbox";
  lightbox.setAttribute("aria-hidden", "true");
  lightbox.setAttribute("role", "dialog");
  lightbox.setAttribute("aria-modal", "true");
  lightbox.setAttribute("aria-label", "Expanded image viewer");

  lightbox.innerHTML = `
    <button
      class="image-lightbox-close"
      type="button"
      aria-label="Close expanded image"
    >
      ×
    </button>

    <img
      class="image-lightbox-content"
      alt=""
    />
  `;

  document.body.appendChild(lightbox);

  const lightboxImage = lightbox.querySelector(".image-lightbox-content");
  const closeButton = lightbox.querySelector(".image-lightbox-close");

  let lastFocusedElement = null;

  /* =========================================
     OPEN / CLOSE
     ========================================= */

  function openLightbox(image) {
    lastFocusedElement = document.activeElement;

    lightboxImage.src = image.currentSrc || image.src;
    lightboxImage.alt = image.alt || "Expanded image";

    lightbox.classList.add("is-open");
    lightbox.setAttribute("aria-hidden", "false");
    document.body.classList.add("lightbox-open");

    closeButton.focus();
  }

  function closeLightbox() {
    lightbox.classList.remove("is-open");
    lightbox.setAttribute("aria-hidden", "true");
    document.body.classList.remove("lightbox-open");

    setTimeout(() => {
      if (!lightbox.classList.contains("is-open")) {
        lightboxImage.src = "";
      }
    }, 200);

    if (lastFocusedElement) {
      lastFocusedElement.focus();
    }
  }

  /* =========================================
     FIND ALL WEBSITE CONTENT IMAGES
     ========================================= */

  const images = document.querySelectorAll("img");

  images.forEach((image) => {
    /*
      Ignore images that should not open:
      - navigation portrait
      - decorative backgrounds
      - explicitly disabled images
    */

    if (
      image.classList.contains("portrait") ||
      image.classList.contains("no-lightbox") ||
      image.closest('[aria-hidden="true"]') ||
      image.closest(".projects-page-bg")
    ) {
      return;
    }

    image.classList.add("lightbox-enabled");

    image.setAttribute("tabindex", "0");
    image.setAttribute("role", "button");

    image.addEventListener("click", () => {
      openLightbox(image);
    });

    image.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openLightbox(image);
      }
    });
  });

  /* =========================================
     CLOSE CONTROLS
     ========================================= */

  closeButton.addEventListener("click", closeLightbox);

  /* Click outside the image */
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) {
      closeLightbox();
    }
  });

  /* ESC */
  document.addEventListener("keydown", (event) => {
    if (
      event.key === "Escape" &&
      lightbox.classList.contains("is-open")
    ) {
      closeLightbox();
    }
  });
});
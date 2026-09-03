(function () {
  "use strict";

  const MOBILE_BREAKPOINT = 767;
  const sidenav = document.querySelector(".sidenav");
  const headerContent = sidenav?.querySelector(".sidenav_content");
  const menu = sidenav?.querySelector(".sidenav_menu");

  if (!sidenav || !headerContent || !menu) return;

  menu.id = menu.id || "portfolio-navigation";

  const title = document.createElement("span");
  title.className = "mobile-nav-title";
  title.textContent = "Matthew Zhou";
  headerContent.appendChild(title);

  const button = document.createElement("button");
  button.className = "mobile-nav-toggle";
  button.type = "button";
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("aria-controls", menu.id);
  button.setAttribute("aria-label", "Open navigation menu");
  button.innerHTML =
    '<span class="mobile-nav-toggle-icon" aria-hidden="true"><span></span><span></span><span></span></span>';
  sidenav.insertBefore(button, menu);

  function isPhoneLayout() {
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
  }

  function setMenuOpen(open, returnFocus) {
    const shouldOpen = Boolean(open && isPhoneLayout());
    sidenav.classList.toggle("mobile-nav-open", shouldOpen);
    document.body.classList.toggle("mobile-nav-lock", shouldOpen);
    button.setAttribute("aria-expanded", String(shouldOpen));
    button.setAttribute(
      "aria-label",
      shouldOpen ? "Close navigation menu" : "Open navigation menu",
    );

    if (shouldOpen) {
      const firstLink = menu.querySelector("a");
      firstLink?.focus({ preventScroll: true });
    } else if (returnFocus) {
      button.focus({ preventScroll: true });
    }
  }

  button.addEventListener("click", function () {
    setMenuOpen(button.getAttribute("aria-expanded") !== "true", false);
  });

  menu.addEventListener("click", function (event) {
    if (event.target.closest("a")) setMenuOpen(false, false);
  });

  document.addEventListener("pointerdown", function (event) {
    if (
      sidenav.classList.contains("mobile-nav-open") &&
      !sidenav.contains(event.target)
    ) {
      setMenuOpen(false, false);
    }
  });

  document.addEventListener("keydown", function (event) {
    if (
      event.key === "Escape" &&
      sidenav.classList.contains("mobile-nav-open")
    ) {
      setMenuOpen(false, true);
    }
  });

  window.addEventListener("resize", function () {
    if (!isPhoneLayout()) setMenuOpen(false, false);
  });
})();

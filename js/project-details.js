(function () {
  "use strict";

  const phoneLayout = window.matchMedia("(max-width: 767px)");
  const mediaSelector = [
    "figure",
    "img",
    "video",
    "iframe",
    "model-viewer",
    ".project-detail-media",
    ".project-detail-media-grid",
    ".project-detail-model-viewer",
    ".project-detail-embed",
  ].join(",");

  document
    .querySelectorAll(".project-detail-section-block")
    .forEach(function (section, sectionIndex) {
      const heading = section.querySelector(".project-detail-section-title");
      if (!heading) return;

      const collapsibleItems = [];

      section
        .querySelectorAll(".project-detail-text-column")
        .forEach(function (column) {
          Array.from(column.children).forEach(function (item) {
            if (item === heading || item.matches(mediaSelector)) return;
            if (item.querySelector(mediaSelector)) return;

            item.classList.add("project-detail-collapsible-text");
            collapsibleItems.push(item);
          });
        });

      section
        .querySelectorAll(".project-detail-special-block")
        .forEach(function (specialBlock) {
          if (collapsibleItems.includes(specialBlock)) return;

          specialBlock.classList.add("project-detail-collapsible-text");
          collapsibleItems.push(specialBlock);
        });

      if (!collapsibleItems.length) return;

      if (!section.id) {
        section.id = `project-section-${sectionIndex + 1}`;
      }

      const headingRow = document.createElement("div");
      headingRow.className = "project-detail-section-heading-row";
      heading.parentNode.insertBefore(headingRow, heading);
      headingRow.appendChild(heading);

      const headingText = heading.textContent.trim();
      heading.textContent = "";

      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.className = "project-detail-text-toggle";
      toggle.setAttribute("aria-controls", section.id);

      const titleLine = document.createElement("span");
      titleLine.className = "project-detail-text-toggle-title-line";

      const visibleHeading = document.createElement("span");
      visibleHeading.className = "project-detail-text-toggle-heading";
      visibleHeading.textContent = headingText;

      const arrow = document.createElement("span");
      arrow.className = "project-detail-text-toggle-arrow";
      arrow.setAttribute("aria-hidden", "true");
      arrow.textContent = "▶";

      const hint = document.createElement("span");
      hint.className = "project-detail-text-toggle-hint";

      titleLine.append(visibleHeading, arrow);
      toggle.append(titleLine, hint);
      heading.appendChild(toggle);

      function setExpanded(expanded) {
        const interactionWord = phoneLayout.matches ? "Tap" : "Click";

        section.classList.toggle("project-detail-text-expanded", expanded);
        toggle.setAttribute("aria-expanded", String(expanded));
        toggle.setAttribute(
          "aria-label",
          `${expanded ? "Hide" : "Show"} text for ${headingText}`,
        );
        hint.textContent = `${interactionWord} to ${expanded ? "hide" : "show"} details`;

        collapsibleItems.forEach(function (item) {
          item.hidden = !expanded;
        });
      }

      toggle.addEventListener("click", function () {
        setExpanded(toggle.getAttribute("aria-expanded") !== "true");
      });

      setExpanded(!phoneLayout.matches);
      section.classList.add("project-detail-has-text-toggle");
    });
})();

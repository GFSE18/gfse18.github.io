fetch("https://overseer.matthewzhou05.workers.dev", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    page: window.location.pathname,
    referrer: document.referrer
  })
}).catch(() => {});
function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable (private mode, blocked cookies) */
  }
}

function toggleTheme() {
  document.body.classList.toggle("light");
  storageSet("theme", document.body.classList.contains("light") ? "light" : "dark");
  updateThemeButton();
}

function acceptCookies() {
  storageSet("cookiesAccepted", "true");
  const banner = document.getElementById("cookie-banner");

  if (banner) {
    banner.style.display = "none";
  }
}

function updateThemeButton() {
  const button = document.querySelector(".theme-toggle");

  if (!button) {
    return;
  }

  const isLight = document.body.classList.contains("light");
  button.textContent = isLight ? "Dark" : "Light";
  button.setAttribute("aria-label", `Switch to ${isLight ? "dark" : "light"} theme`);
}

function markActiveNavLink() {
  let currentPage = window.location.pathname.split("/").pop() || "index.html";
  if (!currentPage.includes(".")) {
    currentPage += ".html";
  }

  const links = document.querySelectorAll(".nav-links a");

  links.forEach(function (link) {
    if (link.getAttribute("href") === currentPage) {
      link.setAttribute("aria-current", "page");
    }
  });
}

function setupContactForm() {
  const form = document.getElementById("consultation-form");
  const status = document.getElementById("form-status");

  if (!form || !status) {
    return;
  }

  form.addEventListener("submit", async function (event) {
    event.preventDefault();

    if (!form.checkValidity()) {
      form.reportValidity();
      return;
    }

    status.textContent = "Sending your request...";
    status.classList.add("visible");

    const jsCheck = form.elements.js_check;
    if (jsCheck) {
      jsCheck.value = "human";
    }

    try {
      const formData = new FormData(form);
      const payload = Object.fromEntries(formData.entries());
      const data = await postJson("/.netlify/functions/contact", payload);

      status.textContent = data.message || "Thanks. Your request has been received.";
      form.reset();
    } catch (error) {
      status.textContent = error.message || "Unable to send your request right now.";
    }
  });
}

function setupCheckoutButtons() {
  const buttons = document.querySelectorAll("[data-checkout-service]");

  buttons.forEach(function (button) {
    const originalText = button.textContent;

    button.addEventListener("click", async function () {
      button.disabled = true;
      button.textContent = "Opening checkout...";

      try {
        const data = await postJson("/.netlify/functions/create-checkout-session", {
          service: button.dataset.checkoutService
        });

        window.location.href = data.url;
      } catch (error) {
        alert(error.message || "Payment could not be started.");
        button.disabled = false;
        button.textContent = originalText;
      }
    });
  });
}

function setupCheckoutStatus() {
  const summary = document.querySelector("[data-checkout-summary]");

  if (!summary) {
    return;
  }

  const eyebrow = document.querySelector("[data-checkout-eyebrow]");
  const title = document.querySelector("[data-checkout-title]");
  const body = document.querySelector("[data-checkout-body]");

  function showState(state) {
    const copy = {
      paid: [
        "Payment received",
        "Thank you for your purchase.",
        "Your payment has been received. Bucurie Digital will be in touch by email with onboarding steps and anything needed to begin your service."
      ],
      unpaid: [
        "Payment not completed",
        "We could not confirm a payment.",
        "No payment was taken for this checkout. If you think this is wrong, email contact@bucuriedigital.com and include the time you paid."
      ],
      unknown: [
        "Payment status unavailable",
        "We could not check your payment right now.",
        "If you completed payment you will receive a receipt from Stripe by email. Contact contact@bucuriedigital.com if anything looks wrong."
      ]
    }[state];
    if (eyebrow) eyebrow.textContent = copy[0];
    if (title) title.textContent = copy[1];
    if (body) body.textContent = copy[2];
  }

  const sessionId = new URLSearchParams(window.location.search).get("session_id");

  if (!sessionId) {
    showState("unknown");
    return;
  }

  getJson("/.netlify/functions/get-checkout-session?session_id=" + encodeURIComponent(sessionId))
    .then(function (data) {
      if (!data || !data.paid) {
        showState("unpaid");
        return;
      }

      showState("paid");

      const parts = [];
      if (data.service) {
        parts.push(data.service);
      }
      if (typeof data.amountTotal === "number") {
        parts.push(
          new Intl.NumberFormat("en-GB", {
            style: "currency",
            currency: (data.currency || "gbp").toUpperCase()
          }).format(data.amountTotal / 100)
        );
      }

      summary.textContent = parts.length
        ? "Confirmed: " + parts.join(" · ") + "."
        : "Your payment is confirmed.";
      summary.classList.add("visible");
    })
    .catch(function () {
      showState("unknown");
    });
}

function setupAssessment() {
  const assessment = document.querySelector("[data-assessment]");

  if (!assessment) {
    return;
  }

  const checkboxes = assessment.querySelectorAll("input[type='checkbox']");
  const score = assessment.querySelector("[data-assessment-score]");
  const message = assessment.querySelector("[data-assessment-message]");

  function updateAssessment() {
    const total = checkboxes.length;
    const selected = Array.from(checkboxes).filter(function (checkbox) {
      return checkbox.checked;
    }).length;

    score.textContent = `${selected}/${total} ready signals`;

    if (selected <= 2) {
      message.textContent = "Start with an Identity Security Audit or Cybersecurity Health Check.";
    } else if (selected <= 4) {
      message.textContent = "Account Hardening or a Cyber Risk Assessment can help prioritise the remaining gaps.";
    } else {
      message.textContent = "You may be ready for ISO 27001 Readiness or deeper documentation support.";
    }
  }

  checkboxes.forEach(function (checkbox) {
    checkbox.addEventListener("change", updateAssessment);
  });

  updateAssessment();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await response.json();

  if (!response.ok) {
    const message = data.error || (data.errors && data.errors.join(" ")) || "Request failed.";
    throw new Error(message);
  }

  return data;
}

async function getJson(url) {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || "Request failed.");
  }

  return data;
}

document.addEventListener("DOMContentLoaded", function () {
  if (storageGet("theme") === "light") {
    document.body.classList.add("light");
  }

  updateThemeButton();
  markActiveNavLink();
  setupContactForm();
  setupCheckoutButtons();
  setupCheckoutStatus();
  setupAssessment();

  const themeToggle = document.querySelector(".theme-toggle");
  if (themeToggle) {
    themeToggle.addEventListener("click", toggleTheme);
  }

  const banner = document.getElementById("cookie-banner");
  const cookieAccept = document.querySelector("[data-cookie-accept]");

  if (cookieAccept) {
    cookieAccept.addEventListener("click", acceptCookies);
  }

  if (banner && !storageGet("cookiesAccepted")) {
    banner.style.display = "block";
  }
});

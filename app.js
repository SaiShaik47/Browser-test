const $ = (s) => document.querySelector(s);

const year = new Date().getFullYear();
$("#year").textContent = String(year);

const root = document.documentElement;
const savedTheme = localStorage.getItem("theme");
if (savedTheme === "light") root.classList.add("light");

const toggle = $("#themeToggle");
const setToggleIcon = () => {
  toggle.textContent = root.classList.contains("light") ? "☀️" : "🌙";
};
setToggleIcon();

toggle.addEventListener("click", () => {
  root.classList.toggle("light");
  localStorage.setItem("theme", root.classList.contains("light") ? "light" : "dark");
  setToggleIcon();
});

$("#planForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const raw = $("#goals").value.trim();
  const output = $("#planOutput");

  if (!raw) {
    output.innerHTML = `<h3>Need goals first</h3><p>Add at least one goal to build your plan.</p>`;
    return;
  }

  const goals = raw
    .split(/[\n,]+/)
    .map((g) => g.trim())
    .filter(Boolean)
    .slice(0, 6);

  const list = goals
    .map((goal, i) => `<li><strong>${i + 1}. ${goal}</strong><br><small>Do a focused 25-minute sprint, then take a 5-minute break.</small></li>`)
    .join("");

  output.innerHTML = `
    <h3>Your Best Plan</h3>
    <ol>${list}</ol>
    <p><strong>Tip:</strong> Start with the hardest task first for maximum momentum.</p>
  `;
});

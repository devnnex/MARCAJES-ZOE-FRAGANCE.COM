"use strict";
const [workerSelect, liquidWorker, timeLogsTable, timeLoader, timeTableCaption, kpiWorkers, kpiHours, kpiPay, kpiMonth] =
  ["workerSelect", "liquidWorker", "timeLogsTable", "timeLoader", "timeTableCaption", "kpiWorkers", "kpiHours", "kpiPay", "kpiMonth"].map(id => document.getElementById(id));
const [globalLoader, globalLoaderTitle, globalLoaderText] = ["globalLoader", "globalLoaderTitle", "globalLoaderText"].map(id => document.getElementById(id));
let apiUrl = "", adminToken = "", timeSectionLoading = false, attendanceBusy = false, dataEpoch = 0;
let displayedLogs = [], hasMoreLogs = false, logsSequence = 0, serverOffset = 0;

const COP = new Intl.NumberFormat("es-CO", {
  style: "currency",
  currency: "COP",
  maximumFractionDigits: 0
});

const premiumModal = Swal.mixin({
  background: "transparent",
  buttonsStyling: false,
  confirmButtonText: "Entendido",
  customClass: {
    popup: "apple-modal",
    title: "apple-modal-title",
    htmlContainer: "apple-modal-text",
    actions: "apple-modal-actions",
    confirmButton: "apple-modal-btn",
    cancelButton: "apple-modal-btn apple-modal-btn-secondary"
  },
  showClass: {
    popup: "apple-modal-show"
  },
  hideClass: {
    popup: "apple-modal-hide"
  }
});

let currentHourRate = null;
let currentWorkers = [];
let attendanceMode = "single";
let selectedBatchWorkers = new Set();
let adminUnlocked = false;
let liquidationHistory = [];
const visualDaysBaselineByWorker = new Map();
const readCache = new Map();
const inFlightReads = new Map();
const liquidationsInFlight = new Set();

const PROTECTED_SECTIONS = new Set(["dashboard", "workers", "history"]);
const READ_CACHE_MS = 7000;
const FAST_CACHE_MS = 3000;
const LIQUIDATION_REQUEST_ATTEMPTS = 2;
const LIQUIDATION_CONFIRMATION_ATTEMPTS = 4;
const LIQUIDATION_CONFIRMATION_DELAY_MS = 500;

function formatCOP(value){
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)){
    return COP.format(0);
  }

  return COP.format(Math.round(numericValue));
}

function formatHoursValue(value){
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)){
    return "0";
  }

  return Number.isInteger(numericValue) ? String(numericValue) : numericValue.toFixed(2).replace(/\.?0+$/, "");
}

function formatEmailMoney(value){
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)){
    return "0";
  }

  return new Intl.NumberFormat("es-CO", {
    maximumFractionDigits: 0
  }).format(Math.round(numericValue));
}

function toFiniteNumber(value, fallback = 0){
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : fallback;
}

function showPremiumModal(options = {}){
  return premiumModal.fire(options);
}

function getWorkerHourlyRate(worker = {}){
  const candidates = [
    worker.hourly_rate,
    worker.hourlyRateRaw,
    worker.workerHourlyRate
  ];

  for (const candidate of candidates){
    if (candidate === "" || candidate === null || candidate === undefined){
      continue;
    }

    const numericValue = Number(candidate);
    if (Number.isFinite(numericValue) && numericValue > 0){
      return numericValue;
    }
  }

  return null;
}

function escapeHTML(value){
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeEmailAddress(value){
  return String(value ?? "").trim().toLowerCase();
}

function isValidEmailAddress(value){
  const email = normalizeEmailAddress(value);
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function getWorkerNameById(workerId){
  const matchedWorker = currentWorkers.find(worker => String(worker.id) === String(workerId));
  return matchedWorker?.name || "Trabajador";
}

function buildWorkerIdentifierPayload(workerId){
  const normalizedWorkerId = String(workerId ?? "").trim();

  // Mantiene compatibilidad con los contratos anterior y actual del Apps Script.
  return {
    worker: normalizedWorkerId,
    worker_id: normalizedWorkerId
  };
}

function setAttendanceMode(mode = "single"){
  attendanceMode = mode === "multi" ? "multi" : "single";

  const isMulti = attendanceMode === "multi";
  const modeSingleBtn = document.getElementById("modeSingleBtn");
  const modeMultiBtn = document.getElementById("modeMultiBtn");
  const multiWorkerPanel = document.getElementById("multiWorkerPanel");

  if (modeSingleBtn){
    modeSingleBtn.classList.toggle("active", !isMulti);
  }

  if (modeMultiBtn){
    modeMultiBtn.classList.toggle("active", isMulti);
  }

  if (multiWorkerPanel){
    multiWorkerPanel.classList.toggle("visible", isMulti);
    multiWorkerPanel.setAttribute("aria-hidden", String(!isMulti));
  }

  if (isMulti && selectedBatchWorkers.size === 0 && workerSelect.value){
    selectedBatchWorkers.add(String(workerSelect.value));
  }

  renderMultiWorkerList(currentWorkers);
}

function handleBatchWorkerToggle(workerId, isSelected){
  const normalizedId = String(workerId || "").trim();
  if (!normalizedId){
    return;
  }

  if (isSelected){
    selectedBatchWorkers.add(normalizedId);
  } else {
    selectedBatchWorkers.delete(normalizedId);
  }
}

function toggleAllBatchWorkers(shouldSelect){
  const workerIds = currentWorkers.map(worker => String(worker.id));
  selectedBatchWorkers = shouldSelect ? new Set(workerIds) : new Set();
  renderMultiWorkerList(currentWorkers);
}

function renderMultiWorkerList(workers = []){
  const multiWorkerList = document.getElementById("multiWorkerList");
  if (!multiWorkerList){
    return;
  }

  const validWorkers = Array.isArray(workers) ? workers : [];

  if (!validWorkers.length){
    multiWorkerList.innerHTML = `<div class="multi-worker-empty">No hay trabajadores disponibles para seleccion multiple.</div>`;
    return;
  }

  const availableIds = new Set(validWorkers.map(worker => String(worker.id)));
  selectedBatchWorkers = new Set([...selectedBatchWorkers].filter(workerId => availableIds.has(workerId)));

  multiWorkerList.innerHTML = validWorkers.map(worker => {
    const workerId = String(worker.id);
    const workerName = escapeHTML(worker.name || "Sin nombre");
    const checkedAttribute = selectedBatchWorkers.has(workerId) ? "checked" : "";

    return `
      <label class="multi-worker-item">
        <input type="checkbox" class="multi-worker-check" data-worker-id="${escapeHTML(workerId)}" ${checkedAttribute}>
        <span>${workerName}</span>
      </label>
    `;
  }).join("");

  multiWorkerList.querySelectorAll(".multi-worker-check").forEach(input => {
    input.addEventListener("change", event => {
      const target = event.currentTarget;
      handleBatchWorkerToggle(target.dataset.workerId, target.checked);
    });
  });
}

async function openAttendanceOverviewModal(){
  setGlobalLoader(true, {
    title: "Actualizando turnos",
    text: "Estamos consultando el estado actual de los trabajadores."
  });

  let workers = currentWorkers;

  try {
    workers = await getWorkersData();
    renderWorkers(workers);
  } finally {
    setGlobalLoader(false);
  }

  const validWorkers = Array.isArray(workers) ? workers : [];
  const activeCount = validWorkers.filter(worker => parseWorkerActiveState(worker.active)).length;
  const inactiveCount = Math.max(validWorkers.length - activeCount, 0);
  const renderOverviewItems = filter => {
    const filteredWorkers = validWorkers.filter(worker => {
      const isActive = parseWorkerActiveState(worker.active);
      if (filter === "active"){
        return isActive;
      }
      if (filter === "inactive"){
        return !isActive;
      }
      return true;
    });

    return filteredWorkers.length
      ? filteredWorkers.map(worker => {
          const isActive = parseWorkerActiveState(worker.active);
          return `
            <div class="attendance-overview-item">
              <span>${escapeHTML(worker.name || "Sin nombre")}</span>
              ${isActive
                ? `<strong class="attendance-status-in">EN TURNO</strong>`
                : `<strong class="attendance-status-out">FUERA DE TURNO</strong>`}
            </div>
          `;
        }).join("")
      : `<div class="attendance-overview-empty">No hay trabajadores para este filtro.</div>`;
  };

  await showPremiumModal({
    title: "Vista general de turnos",
    html: `
      <div class="attendance-overview-modal">
        <div class="attendance-overview-summary">
          <button class="attendance-overview-kpi" type="button" data-filter="active">
            <span>En turno</span>
            <strong>${activeCount}</strong>
          </button>
          <button class="attendance-overview-kpi" type="button" data-filter="inactive">
            <span>Fuera de turno</span>
            <strong>${inactiveCount}</strong>
          </button>
        </div>

        <div class="attendance-overview-list" id="attendanceOverviewList">
          ${validWorkers.length ? renderOverviewItems("all") : `<div class="attendance-overview-empty">No hay trabajadores disponibles.</div>`}
        </div>
      </div>
    `,
    confirmButtonText: "Entendido",
    didOpen: () => {
      const overviewList = document.getElementById("attendanceOverviewList");
      const filterButtons = document.querySelectorAll(".attendance-overview-kpi");
      let selectedFilter = "all";

      filterButtons.forEach(button => {
        button.addEventListener("click", () => {
          const nextFilter = button.dataset.filter || "all";
          selectedFilter = selectedFilter === nextFilter ? "all" : nextFilter;

          filterButtons.forEach(filterButton => {
            filterButton.classList.toggle(
              "selected",
              selectedFilter !== "all" && filterButton.dataset.filter === selectedFilter
            );
          });

          if (overviewList){
            overviewList.innerHTML = validWorkers.length
              ? renderOverviewItems(selectedFilter)
              : `<div class="attendance-overview-empty">No hay trabajadores disponibles.</div>`;
          }
        });
      });
    }
  });
}

function getRateElements(){
  return {
    currentRateLabel: document.getElementById("currentRateValue"),
    rateInput: document.getElementById("hourRate")
  };
}

function clearRateInput(){
  const rateInput = document.getElementById("hourRate");
  if (rateInput){
    rateInput.value = "";
  }
}

function renderCurrentRate(value){
  const currentRateLabel = document.getElementById("currentRateValue");
  const currentRateDisplay = document.getElementById("currentRateDisplay");
  const numericValue = Number(value);

  if (!Number.isFinite(numericValue) || numericValue <= 0){
    return;
  }

  const formattedRate = formatCOP(numericValue);

  if (currentRateLabel){
    currentRateLabel.textContent = formattedRate;
    currentRateLabel.innerText = formattedRate;
    currentRateLabel.setAttribute("data-rate-value", String(numericValue));
  }

  if (currentRateDisplay){
    currentRateDisplay.textContent = formattedRate;
    currentRateDisplay.innerText = formattedRate;
    currentRateDisplay.setAttribute("data-rate-value", String(numericValue));
  }
}

function getWorkerFormFields(){
  return {
    nameInput: document.getElementById("name"),
    phoneInput: document.getElementById("phone"),
    emailInput: document.getElementById("email")
  };
}

function wait(ms){
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatMinutes(mins){
  if (mins < 60) return mins + " min";

  const h = Math.floor(mins / 60);
  const m = mins % 60;

  return m === 0 ? `${h}h` : `${h}h ${m} m`;
}

function toggleRateBoxVisibility(sectionId){
  const rateBox = document.getElementById("rateBox");
  if (!rateBox){
    return;
  }

  rateBox.classList.toggle("hidden-by-section", sectionId === "time" || sectionId === "history");
}

function setActiveSectionUI(id){
  document.querySelectorAll(".section")
    .forEach(section => section.classList.remove("active"));

  document.getElementById(id).classList.add("active");
  document.querySelectorAll(".sidebar .nav-btn")
    .forEach(button => button.classList.toggle("active", button.dataset.section === id));
  toggleRateBoxVisibility(id);
  document.getElementById("moreLogsButton").hidden = id !== "time" || !hasMoreLogs;
}

function isProtectedSection(id){
  return PROTECTED_SECTIONS.has(id);
}

async function requestAdminAccess(){
  if (!apiUrl) { await showPremiumModal({ icon: "info", title: "Pendiente de activación", text: "El sistema estará disponible pronto." }); return false; }
  const result = await showPremiumModal({
    title: "PIN de administrador", input: "password", inputLabel: "Ingresa el PIN de 4 dígitos",
    inputAttributes: { inputmode: "numeric", maxlength: "4", autocomplete: "off" },
    showCancelButton: true, confirmButtonText: "Ingresar", cancelButtonText: "Cancelar", showLoaderOnConfirm: true,
    preConfirm: async pin => {
      if (!/^\d{4}$/.test(pin)) { Swal.showValidationMessage("Ingresa los 4 dígitos del PIN."); return false; }
      try { return await api("login", { pin }); }
      catch (error) { Swal.showValidationMessage(error.message); return false; }
    }
  });
  if (!result.isConfirmed || !result.value?.token) return false;
  adminToken = result.value.token;
  adminUnlocked = true;
  document.getElementById("lockAdminButton").hidden = false;
  return true;
}

async function showSection(id){
  if (isProtectedSection(id) && !adminUnlocked){
    const hasAccess = await requestAdminAccess();
    if (!hasAccess){
      if (id !== "time"){
        setActiveSectionUI("time");
        await loadTimeSection();
      }
      return;
    }
  }

  setActiveSectionUI(id);

  if (id === "workers"){
    await loadWorkers();
  }

  if (id === "dashboard"){
    await loadDashboard();
  }

  if (id === "time"){
    await loadTimeSection();
  }

  if (id === "history"){
    await Promise.allSettled([
      loadLiquidationsHistory({ showLoader: true }),
      loadWorkers()
    ]);
    populateLiquidationWorkerFilter(liquidationHistory);
    renderLiquidationsHistory();
  }
}

async function loadTimeSection(){
  if (!apiUrl || timeSectionLoading || attendanceBusy) return;
  timeSectionLoading = true;
  const epoch = dataEpoch;
  const selectedAtStart = String(workerSelect.value || "");
  setTimeLoader(true);
  try {
    const bootstrap = await api("getTimeBootstrap", { worker: selectedAtStart }, { cacheMs: FAST_CACHE_MS, force: true });
    if (epoch !== dataEpoch) return;
    if (bootstrap.serverTime) serverOffset = new Date(bootstrap.serverTime).getTime() - Date.now();
    renderWorkers(bootstrap.workers);
    if (bootstrap.rate > 0) setCurrentRate(bootstrap.rate);
    if (String(workerSelect.value || "") === (selectedAtStart || bootstrap.selectedWorkerId)) {
      displayedLogs = bootstrap.logs || [];
      hasMoreLogs = Boolean(bootstrap.hasMoreLogs);
      renderTimeLogs(displayedLogs);
    } else { await loadTimeLogs({ showLoader: false }); }
    setConnectionStatus("Conectado · Zoe Fragance", "online");
  } catch (error) {
    setConnectionStatus(error.message, "error");
    if (!currentWorkers.length) timeLogsTable.innerHTML = '<tr><td colspan="4" class="time-empty">No se pudo actualizar. Revisa tu conexión e intenta nuevamente.</td></tr>';
  } finally {
    timeSectionLoading = false;
    setTimeLoader(false);
  }
}

function getApiCacheKey(action, data = {}){
  return `${action}:${JSON.stringify(data || {})}`;
}

function isReadAction(action){
  return /^get/i.test(action);
}

function invalidateReadCache(){
  dataEpoch += 1;
  readCache.clear();
  inFlightReads.clear();
}

async function api(action, data = {}, { cacheMs = 0, force = false } = {}){
  if (!apiUrl) throw new Error("El sistema está pendiente de activación.");
  const read = isReadAction(action);
  const key = getApiCacheKey(action, data);
  if (read) {
    const pending = inFlightReads.get(key);
    if (pending) return pending;
    const cached = readCache.get(key);
    if (!force && cached && Date.now() - cached.timestamp < cacheMs) return cached.value;
  } else if (action !== "login" && action !== "logout") invalidateReadCache();
  const epoch = dataEpoch;
  const promise = fetchFrom(apiUrl, { ...data, action, token: adminToken }).then(result => {
    if (!read && action !== "login" && action !== "logout") invalidateReadCache();
    if (read && epoch === dataEpoch && cacheMs > 0) readCache.set(key, { value: result, timestamp: Date.now() });
    return result;
  }).catch(error => {
    if (error.code === "unauthorized") lockAdmin(false);
    throw error;
  }).finally(() => {
    if (inFlightReads.get(key) === promise) inFlightReads.delete(key);
  });
  if (read) inFlightReads.set(key, promise);
  return promise;
}

async function addWorker(){
  const { nameInput, phoneInput, emailInput } = getWorkerFormFields();
  const payload = {
    name: nameInput.value.trim(),
    phone: phoneInput.value.trim(),
    email: normalizeEmailAddress(emailInput.value)
  };

  if (!payload.name){
    showPremiumModal({
      icon: "warning",
      title: "Nombre requerido",
      text: "Ingresa al menos el nombre del trabajador antes de guardar."
    });
    return;
  }

  if (payload.email && !isValidEmailAddress(payload.email)){
    showPremiumModal({
      icon: "warning",
      title: "Correo no valido",
      text: "Revisa el correo del trabajador antes de guardarlo."
    });
    return;
  }

  setGlobalLoader(true, {
    title: "Guardando trabajador",
    text: "Estamos registrando al trabajador y actualizando la vista."
  });

  let shouldShowSuccess = false;

  try {
    const result = await api("addWorker", payload);
    nameInput.value = "";
    phoneInput.value = "";
    emailInput.value = "";

    insertOptimisticWorker(result, payload);
    shouldShowSuccess = true;
  } finally {
    setGlobalLoader(false);
  }

  void Promise.allSettled([
    loadWorkers({ force: true }),
    loadDashboard({ force: true })
  ]);

  if (shouldShowSuccess){
    await wait(80);
    await showPremiumModal({
      icon: "success",
      title: "Cambio exitoso",
      text: "La información se guardó correctamente."
    });
  }
}

async function getWorkersData({ force = false } = {}){
  return api("getWorkers", {}, {
    cacheMs: READ_CACHE_MS,
    force
  });
}

function renderWorkers(workers = currentWorkers){
  currentWorkers = Array.isArray(workers) ? workers.map(normalizeWorker) : [];
  const searchInput = document.getElementById("workerSearch");
  const cardsContainer = document.getElementById("workersCards");
  const q = (searchInput?.value || "").toLowerCase();

  const filtered = currentWorkers.filter(worker =>
    (worker.name || "").toLowerCase().includes(q)
  );

  cardsContainer.innerHTML = filtered.map(worker => {
    const maxHours = 48;
    const progress = Math.min((worker.hours / maxHours) * 100, 100);
    const money = formatCOP(worker.pay || 0);
    const safeWorkerName = escapeHTML(worker.name || "Sin nombre");
    const workerRate = getWorkerHourlyRate(worker);
    const rateTitle = workerRate
      ? `Tarifa individual: ${formatCOP(workerRate)}`
      : "Configurar tarifa individual";
    const liqDate = worker.lastLiquidation
      ? new Date(worker.lastLiquidation).toLocaleDateString("es-CO", { timeZone: "America/Bogota",
          weekday: "short",
          day: "numeric",
          month: "short",
          year: "numeric"
        })
      : "Sin liquidar";

    const workerId = String(worker.id);
    const rawDays = Number(worker.days || 0);
    const baselineDays = visualDaysBaselineByWorker.get(workerId);
    let visualDays = rawDays;

    if (typeof baselineDays === "number"){
      if (rawDays < baselineDays){
        // El backend reinicio dias; ya no necesitamos el baseline visual.
        visualDaysBaselineByWorker.delete(workerId);
      } else {
        visualDays = Math.max(0, rawDays - baselineDays);
      }
    }

    const status = worker.active
      ? `<div class="worker-active">EN TURNO</div>`
      : `<div class="worker-inactive">Fuera de turno</div>`;

    const timer = worker.active
      ? `<div class="liveTimer" data-start="${worker.activeStart}"></div>`
      : "";

    return `
      <div class="worker-card">
        <div class="worker-header">
          <div class="worker-name-row">
            <span class="worker-name">${safeWorkerName}</span>
            <button class="worker-rate-btn" type="button" onclick="openWorkerRateModal('${worker.id}')" aria-label="Configurar tarifa por hora" title="${escapeHTML(rateTitle)}">$</button>
            <button class="edit-worker-btn" type="button" onclick="editWorker('${worker.id}')" aria-label="Editar trabajador">&#9998;</button>
          </div>
          <span>${money}</span>
        </div>

        <div>Días trabajados: ${visualDays} · ${formatHoursValue(worker.hours)} h cerradas</div>

        ${status}
        ${timer}

        <div class="progress-bar">
          <div class="progress" style="width:${progress}%"></div>
        </div>

        <div class="last-payment">
          Ultima liquidacion: ${liqDate}
        </div>

        <div class="card-actions">
          <button class="liquidate-btn" onclick="liquidate('${worker.id}')">Liquidar</button>
          <button class="delete-btn" onclick="deleteWorker('${worker.id}')">Eliminar</button>
        </div>
      </div>
    `;
  }).join("");

  if (!filtered.length) cardsContainer.innerHTML = '<p class="time-empty">No hay trabajadores para mostrar.</p>';
  fillWorkerSelects(currentWorkers);
  renderActiveShift();
}

function handleWorkerSearch(){
  renderWorkers(currentWorkers);
}

async function loadWorkers({ force = false } = {}){
  const epoch = dataEpoch;
  const workers = await getWorkersData({ force });
  if (epoch !== dataEpoch) return currentWorkers;
  renderWorkers(workers);
  return workers;
}

async function refreshWorkers(){
  setGlobalLoader(true, {
    title: "Refrescando trabajadores",
    text: "Estamos cargando la lista mas reciente desde el backend."
  });

  try {
    await loadWorkers({ force: true });
  } finally {
    setGlobalLoader(false);
  }
}

async function syncWorkersUI({
  match,
  attempts = 6,
  delayMs = 450,
  loaderTitle = "Actualizando trabajadores",
  loaderText = "Estamos sincronizando la informacion mas reciente."
} = {}){
  let workers = [];

  for (let attempt = 0; attempt < attempts; attempt += 1){
    setGlobalLoader(true, {
      title: loaderTitle,
      text: loaderText
    });

    workers = await getWorkersData();
    renderWorkers(workers);

    if (!match || match(workers)){
      return workers;
    }

    await wait(delayMs);
  }

  return workers;
}

function fillWorkerSelects(workers){
  const selectedWorker = workerSelect.value;
  const selectedLiquidWorker = liquidWorker.value;

  workerSelect.innerHTML = "";
  liquidWorker.innerHTML = "";

  workers.forEach(worker => {
    [workerSelect, liquidWorker].forEach(select => {
      const option = document.createElement("option");
      option.value = String(worker.id ?? "");
      option.textContent = worker.name || "Sin nombre";
      select.appendChild(option);
    });
  });

  if (selectedWorker && workers.some(worker => String(worker.id) === String(selectedWorker))){
    workerSelect.value = selectedWorker;
  }

  if (selectedLiquidWorker && workers.some(worker => String(worker.id) === String(selectedLiquidWorker))){
    liquidWorker.value = selectedLiquidWorker;
  }

  const availableIds = new Set(workers.map(worker => String(worker.id)));
  selectedBatchWorkers = new Set([...selectedBatchWorkers].filter(workerId => availableIds.has(workerId)));

  if (selectedBatchWorkers.size === 0 && workerSelect.value){
    selectedBatchWorkers.add(String(workerSelect.value));
  }

  renderMultiWorkerList(workers);
}

async function deleteWorker(id){
  const confirmation = await showPremiumModal({ icon: "question", title: "¿Retirar trabajador?", text: "El historial de marcajes y pagos se conservará. Debes cerrar y liquidar los turnos pendientes.", showCancelButton: true, confirmButtonText: "Retirar", cancelButtonText: "Cancelar" });
  if (!confirmation.isConfirmed) return;
  setGlobalLoader(true, {
    title: "Eliminando trabajador",
    text: "Estamos actualizando la lista para reflejar el cambio."
  });

  try {
    await api("deleteWorker", { id });
    removeOptimisticWorker(id);
  } finally {
    setGlobalLoader(false);
  }

  void Promise.allSettled([
    loadWorkers({ force: true }),
    loadDashboard({ force: true })
  ]);
}

async function editWorker(id, currentName, currentPhone, currentEmail){
  const workerId = String(id || "").trim();
  if (!workerId){
    showPremiumModal({
      icon: "warning",
      title: "Trabajador no valido",
      text: "No se pudo identificar el trabajador a editar."
    });
    return;
  }

  const workerData = currentWorkers.find(worker => String(worker.id) === workerId) || {};
  const safeName = escapeHTML(currentName ?? workerData.name ?? "");
  const safePhone = escapeHTML(currentPhone ?? workerData.phone ?? "");
  const safeEmail = escapeHTML(currentEmail ?? workerData.email ?? "");

  const { isConfirmed, value } = await showPremiumModal({
    title: "Editar trabajador",
    html: `
      <div class="apple-modal-form">
        <label class="apple-modal-field">
          <span>Nombre</span>
          <input id="swalWorkerName" class="apple-modal-input-field" value="${safeName}" placeholder="Nombre">
        </label>
        <label class="apple-modal-field">
          <span>Telefono</span>
          <input id="swalWorkerPhone" class="apple-modal-input-field" value="${safePhone}" placeholder="Telefono">
        </label>
        <label class="apple-modal-field">
          <span>Email</span>
          <input id="swalWorkerEmail" class="apple-modal-input-field" type="email" autocomplete="email" value="${safeEmail}" placeholder="Correo">
        </label>
      </div>
    `,
    confirmButtonText: "Guardar cambios",
    showCancelButton: true,
    cancelButtonText: "Cancelar",
    focusConfirm: false,
    preConfirm: () => {
      const updatedName = document.getElementById("swalWorkerName").value.trim();
      const updatedPhone = document.getElementById("swalWorkerPhone").value.trim();
      const updatedEmail = document.getElementById("swalWorkerEmail").value.trim();

      if (!updatedName){
        Swal.showValidationMessage("El nombre es obligatorio.");
        return false;
      }

      if (updatedEmail && !isValidEmailAddress(updatedEmail)){
        Swal.showValidationMessage("Ingresa un correo valido o deja el campo vacio.");
        return false;
      }

      return {
        name: updatedName,
        phone: updatedPhone,
        email: normalizeEmailAddress(updatedEmail)
      };
    }
  });

  if (!isConfirmed || !value){
    return;
  }

  setGlobalLoader(true, {
    title: "Guardando cambios",
    text: "Estamos actualizando la informacion del trabajador."
  });

  try {
    await api("updateWorker", {
      id: workerId,
      name: value.name,
      phone: value.phone,
      email: value.email
    });

    updateOptimisticWorker(workerId, value);
    if (workerSelect.value && String(workerSelect.value) === workerId){
      updateSelectedWorkerName(value.name);
    }
  } finally {
    setGlobalLoader(false);
  }

  void Promise.allSettled([
    loadWorkers({ force: true }),
    adminUnlocked ? loadDashboard({ force: true }) : Promise.resolve()
  ]);

  await wait(80);
  await showPremiumModal({
    icon: "success",
    title: "Cambio exitoso",
    text: "La información se guardó correctamente."
  });
}

async function openWorkerRateModal(id){
  const workerId = String(id || "").trim();
  if (!workerId){
    showPremiumModal({
      icon: "warning",
      title: "Trabajador no valido",
      text: "No se pudo identificar el trabajador para configurar la tarifa."
    });
    return;
  }

  const workerData = currentWorkers.find(worker => String(worker.id) === workerId) || {};
  const workerName = workerData.name || "Trabajador";
  const currentRate = getWorkerHourlyRate(workerData);
  const rateHint = currentRate
    ? `Tarifa actual: ${formatCOP(currentRate)}`
    : "Usando tarifa global";

  const { isConfirmed, value } = await showPremiumModal({
    title: "Configurar tarifa por hora",
    html: `
      <div class="worker-rate-modal">
        <div class="worker-rate-context">
          <span>Trabajador</span>
          <strong>${escapeHTML(workerName)}</strong>
        </div>

        <label class="apple-modal-field">
          <span>Valor por hora</span>
          <input id="swalWorkerRate" class="apple-modal-input-field" type="number" inputmode="numeric" min="1" step="1" value="${currentRate ?? ""}" placeholder="Ej: 10000">
        </label>

        <p class="worker-rate-hint">${rateHint}</p>
      </div>
    `,
    confirmButtonText: "Guardar",
    showCancelButton: true,
    cancelButtonText: "Cancelar",
    focusConfirm: false,
    customClass: {
      popup: "apple-modal",
      title: "apple-modal-title",
      htmlContainer: "apple-modal-text",
      actions: "apple-modal-actions",
      confirmButton: "apple-modal-btn worker-rate-save-btn",
      cancelButton: "apple-modal-btn apple-modal-btn-secondary"
    },
    didOpen: () => {
      const rateInput = document.getElementById("swalWorkerRate");
      if (rateInput){
        rateInput.focus();
        rateInput.select();
      }
    },
    preConfirm: () => {
      const rateInput = document.getElementById("swalWorkerRate");
      const numericRate = Number(rateInput?.value || 0);

      if (!Number.isFinite(numericRate) || numericRate <= 0){
        Swal.showValidationMessage("Ingresa una tarifa mayor a cero.");
        return false;
      }

      return Math.round(numericRate);
    }
  });

  if (!isConfirmed || !value){
    return;
  }

  setGlobalLoader(true, {
    title: "Guardando tarifa",
    text: "Estamos actualizando el valor por hora del trabajador."
  });

  try {
    await api("setWorkerRate", {
      worker: workerId,
      rate: value
    });

    currentWorkers = currentWorkers.map(worker =>
      String(worker.id) === workerId
        ? { ...worker, hourly_rate: value, hourlyRate: value }
        : worker
    );
    renderWorkers(currentWorkers);
  } finally {
    setGlobalLoader(false);
  }

  void Promise.allSettled([
    loadWorkers({ force: true }),
    adminUnlocked ? loadDashboard({ force: true }) : Promise.resolve()
  ]);

  await showPremiumModal({
    icon: "success",
    title: "Tarifa guardada",
    text: `${workerName} ahora tiene una tarifa de ${formatCOP(value)} por hora.`
  });
}

function getSelectedAttendanceWorkerIds(){
  if (attendanceMode === "multi"){
    const availableIds = new Set(currentWorkers.map(worker => String(worker.id)));
    return [...selectedBatchWorkers].filter(workerId => availableIds.has(workerId));
  }

  const selectedWorkerId = String(workerSelect.value || "").trim();
  return selectedWorkerId ? [selectedWorkerId] : [];
}

function formatAttendanceTime(rawTime){
  if (!rawTime){
    return "ahora";
  }

  const parsedTime = new Date(rawTime);
  if (Number.isNaN(parsedTime.getTime())){
    return "ahora";
  }

  return parsedTime.toLocaleTimeString("es-CO", { timeZone: "America/Bogota",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function formatLiquidationDate(rawDate){
  const date = new Date(rawDate);
  if (Number.isNaN(date.getTime())){
    return "Fecha no disponible";
  }

  const datePart = date
    .toLocaleDateString("es-CO", { timeZone: "America/Bogota",
      weekday: "short",
      day: "numeric",
      month: "short",
      year: "numeric"
    })
    .replace(/,/g, "")
    .replace(/\./g, "");

  const timePart = date.toLocaleTimeString("en-US", {
    timeZone: "America/Bogota",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  });

  return `${datePart} ${timePart}`;
}

function normalizeSearchText(value){
  return String(value ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function getLiquidationDate(rawDate){
  const date = new Date(rawDate);
  return Number.isNaN(date.getTime()) ? null : date;
}

function getLiquidationDayKey(rawDate){
  const date = getLiquidationDate(rawDate);
  if (!date){
    return "";
  }

  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/Bogota", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function formatLiquidationDayLabel(rawDate){
  const date = getLiquidationDate(rawDate);
  if (!date){
    return "Fecha no disponible";
  }

  return date.toLocaleDateString("es-CO", { timeZone: "America/Bogota",
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric"
  })
  .replace(/,/g, "")
  .replace(/\./g, "");
}

function buildBatchAttendanceRows(results, maxRows = 8){
  const visibleRows = results.slice(0, maxRows);
  const remainingCount = Math.max(results.length - maxRows, 0);

  const rows = visibleRows.map(result => `
    <div class="apple-liquidation-row">
      <span>${escapeHTML(result.name || getWorkerNameById(result.workerId))}</span>
      <strong>${result.confirmedByState ? "Confirmado" : formatAttendanceTime(result.time)}</strong>
    </div>
  `).join("");

  if (!remainingCount){
    return rows;
  }

  return `${rows}
    <div class="apple-liquidation-row">
      <span>Registros adicionales</span>
      <strong>+${remainingCount}</strong>
    </div>`;
}

function parseWorkerActiveState(value){
  return value === true || value === 1 || ["true", "1", "si", "sí"].includes(String(value).toLowerCase());
}

function operationId(){
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function pendingKey(kind, workerId){ return `zoe-pending:${apiUrl}:${kind}:${workerId}`; }

function getPendingId(kind, workerId){
  const key = pendingKey(kind, workerId);
  let requestId;
  try { requestId = localStorage.getItem(key); } catch (_) {}
  if (!requestId) requestId = operationId();
  try { localStorage.setItem(key, requestId); } catch (_) {}
  return requestId;
}

function forgetPendingId(kind, workerId){
  try { localStorage.removeItem(pendingKey(kind, workerId)); } catch (_) {}
}

async function registerAttendance(action){
  if (attendanceBusy || !apiUrl) return;
  const ids = getSelectedAttendanceWorkerIds();
  if (!ids.length) return showPremiumModal({ icon: "warning", title: "Selecciona un trabajador", text: "Puedes marcar uno o varios trabajadores a la vez." });
  if (navigator.onLine === false) return showPremiumModal({ icon: "warning", title: "Sin conexión", text: "Conéctate a internet antes de marcar. La hora se confirma en el servidor." });
  const isIn = action === "checkIn";
  const entries = ids.map(worker => ({ worker, requestId: getPendingId(action, worker) }));
  attendanceBusy = true;
  invalidateReadCache();
  setAttendanceButtonsBusy(true);
  setGlobalLoader(true, { title: isIn ? "Registrando entradas" : "Registrando salidas", text: `${entries.length} trabajador(es). Espera la confirmación.` });
  try {
    let response;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { response = await api(`${action}Batch`, { entries }); break; }
      catch (error) {
        if (attempt || !["network_error", "timeout", "busy"].includes(error.code)) throw error;
        await wait(300);
      }
    }
    if (!Array.isArray(response?.results) || response.results.length !== entries.length) throw new Error("El servidor no confirmó todos los marcajes. Vuelve a intentar para verificarlos.");
    const results = response.results;
    const succeeded = results.filter(r => r.ok && !r.error);
    const failed = results.filter(r => r.error || !r.ok);
    results.forEach(result => {
      if (!result.error || !["server_error", "busy"].includes(result.code)) forgetPendingId(action, result.workerId);
    });
    succeeded.forEach(result => {
      const worker = currentWorkers.find(w => String(w.id) === String(result.workerId));
      if (!worker) return;
      const wasActive = worker.active;
      worker.active = result.active ?? isIn;
      worker.activeStart = worker.active ? result.start : null;
      worker.activeRate = isIn ? result.hourlyRate : 0;
      if (!isIn && wasActive && !result.alreadyRegistered) { worker.hours += Number(result.hours); worker.pay += Number(result.earned); }
      if (String(workerSelect.value) === String(result.workerId)) {
        const log = { id: result.logId, workerId: worker.id, workerName: worker.name, start: result.start, end: result.end, hours: result.hours, earned: result.earned, hourlyRate: result.hourlyRate };
        displayedLogs = [log, ...displayedLogs.filter(item => item.id !== log.id)];
      }
    });
    renderWorkers(currentWorkers);
    renderTimeLogs(displayedLogs);
    setGlobalLoader(false);
    await showPremiumModal({
      icon: failed.length ? (succeeded.length ? "warning" : "error") : "success",
      title: failed.length ? "Revisa los marcajes" : (isIn ? "Entrada registrada" : "Salida registrada"),
      html: `<div class="apple-liquidation-summary">${results.map(result => `<div class="apple-liquidation-row"><span>${escapeHTML(result.name || getWorkerNameById(result.workerId))}</span><strong>${result.error ? escapeHTML(result.message || "Sin confirmar") : (isIn ? formatAttendanceTime(result.time) : `${formatHoursValue(result.hours)} h · ${formatCOP(result.earned)}`)}</strong></div>`).join("")}</div>`
    });
  } catch (error) {
    setGlobalLoader(false);
    await showPremiumModal({ icon: "warning", title: "Marcaje sin confirmar", text: `${error.message} Vuelve a pulsar el mismo botón para verificar la operación sin duplicarla.` });
  } finally {
    attendanceBusy = false;
    setAttendanceButtonsBusy(false);
    setGlobalLoader(false);
    void loadTimeSection();
  }
}

async function checkIn(){ return registerAttendance("checkIn"); }
async function checkOut(){ return registerAttendance("checkOut"); }

function setAttendanceButtonsBusy(busy){
  document.querySelectorAll(".time-actions button").forEach(button => { button.disabled = busy || !apiUrl; });
}


async function refreshLive({ force = false } = {}){
  await loadWorkers({ force });
  if (adminUnlocked){
    await loadDashboard({ force });
  }
}

async function saveRate(){
  const rateInput = document.getElementById("hourRate");
  const nextRate = Number(rateInput.value);

  if (!Number.isFinite(nextRate) || nextRate <= 0){
    showPremiumModal({
      icon: "warning",
      title: "Valor invalido",
      text: "Ingresa una tarifa por hora valida antes de guardar."
    });
    return;
  }

  if (currentHourRate !== null && Number(currentHourRate) === nextRate){
    return;
  }

  setGlobalLoader(true, {
    title: "Guardando valor por hora",
    text: "Estamos actualizando la tarifa actual del sistema."
  });

  try {
    await api("setRate", { value: nextRate });
    setCurrentRate(nextRate);
    clearRateInput();
    renderCurrentRate(currentHourRate ?? nextRate);

    showPremiumModal({
      icon: "success",
      title: "Tarifa actualizada",
      text: `La hora quedo guardada en ${formatCOP(currentHourRate ?? nextRate)}`
    });
  } finally {
    setGlobalLoader(false);
  }

  void Promise.allSettled([
    loadDashboard({ force: true }),
    loadWorkers({ force: true })
  ]);
}

function normalizeDashboardData(dashboard){
  if (!Array.isArray(dashboard)){
    return dashboard && typeof dashboard === "object" ? dashboard : {};
  }

  const totals = dashboard.reduce((summary, worker) => {
    summary.hours += toFiniteNumber(worker?.hours, 0);
    summary.pay += toFiniteNumber(worker?.pay, 0);
    return summary;
  }, { hours: 0, pay: 0 });

  return {
    workers: dashboard.length,
    hours: formatHoursValue(totals.hours),
    pay: totals.pay,
    rate: getRateFromDashboard(dashboard)
  };
}

async function loadDashboard({ force = false } = {}){
  const epoch = dataEpoch;
  const dashboardResponse = await api("getDashboard", {}, {
    cacheMs: FAST_CACHE_MS,
    force
  });
  if (epoch !== dataEpoch || !adminUnlocked) return;
  const dashboard = normalizeDashboardData(dashboardResponse);

  kpiWorkers.textContent = dashboard.workers;
  kpiHours.textContent = dashboard.hours;
  kpiPay.textContent = formatCOP(dashboard.pay || 0);
  kpiMonth.textContent = dashboard.liquidations ?? 0;

  const backendRate = getRateFromDashboard(dashboard);
  if (backendRate !== null){
    setCurrentRate(backendRate);
  } else if (currentHourRate !== null){
    renderCurrentRate(currentHourRate);
  }
}

async function loadCurrentRate(){
  try {
    const settingsResponse = await api("getSettings", {}, {
      cacheMs: READ_CACHE_MS
    });
    const backendRate = extractRateFromSettings(settingsResponse);

    if (backendRate !== null){
      setCurrentRate(backendRate);
      return backendRate;
    }
  } catch (error){
    // Fallback silencioso a dashboard si la accion no existe o falla.
  }

  try {
    const dashboard = await api("getDashboard", {}, {
      cacheMs: FAST_CACHE_MS
    });
    const backendRate = getRateFromDashboard(dashboard);

    if (backendRate !== null){
      setCurrentRate(backendRate);
      return backendRate;
    }
  } catch (error){
    // Si tambien falla, dejamos el estado actual.
  }

  return null;
}

function getValidLiquidationRecords(records){
  return Array.isArray(records) ? records.filter(r => Number(r.hours_paid) > 0 && Number(r.amount_paid) > 0) : [];
}

function applyLiquidationHistory(records){
  liquidationHistory = getValidLiquidationRecords(records);
  populateLiquidationWorkerFilter(liquidationHistory);
  populateLiquidationDateFilter(liquidationHistory);
  renderLiquidationsHistory();
}

async function liquidate(workerId){
  if (!adminUnlocked && !await requestAdminAccess()) return;
  const id = String(workerId || liquidWorker.value || "");
  if (!id || liquidationsInFlight.has(id)) return;
  const worker = currentWorkers.find(w => String(w.id) === id);
  if (!worker) return;
  if (worker.active) return showPremiumModal({ icon: "warning", title: "Turno abierto", text: "Registra la salida antes de liquidar al trabajador." });
  const confirmation = await showPremiumModal({
    icon: "question", title: "¿Registrar el pago?", showCancelButton: true, confirmButtonText: "Liquidar", cancelButtonText: "Cancelar",
    html: `<div class="apple-liquidation-summary"><div class="apple-liquidation-row"><span>Trabajador</span><strong>${escapeHTML(worker.name)}</strong></div><div class="apple-liquidation-row"><span>Horas cerradas pendientes</span><strong>${formatHoursValue(worker.hours)} h</strong></div><div class="apple-liquidation-row"><span>Total pendiente</span><strong>${formatCOP(worker.pay)}</strong></div></div>`
  });
  if (!confirmation.isConfirmed) return;
  liquidationsInFlight.add(id);
  setGlobalLoader(true, { title: "Registrando liquidación", text: "Guardando el pago y los marcajes incluidos." });
  try {
    const result = await api("liquidateWorker", { worker: id, requestId: getPendingId("liquidate", id) });
    forgetPendingId("liquidate", id);
    // El servidor es la autoridad; no se confirma un pago por un saldo visual en cero.
    worker.hours = 0; worker.pay = 0; worker.days = 0; worker.lastLiquidation = result.liquidation_date;
    renderWorkers(currentWorkers);
    setGlobalLoader(false);
    void Promise.allSettled([loadWorkers({ force: true }), loadDashboard({ force: true })]);
    await showPremiumModal({
      icon: "success", title: result.alreadyRegistered ? "Pago ya registrado" : "Liquidación completada",
      html: `<div class="apple-liquidation-summary"><div class="apple-liquidation-row"><span>Trabajador</span><strong>${escapeHTML(result.name || worker.name)}</strong></div><div class="apple-liquidation-row"><span>Horas pagadas</span><strong>${formatHoursValue(result.hours)} h</strong></div><div class="apple-liquidation-row"><span>Total pagado</span><strong>${formatCOP(result.amount)}</strong></div><div class="apple-liquidation-row"><span>Comprobante</span><strong>${escapeHTML(String(result.id).slice(0, 8).toUpperCase())}</strong></div>${result.emailStatus ? `<p class="receipt-note">${escapeHTML(result.emailStatus)}</p>` : ""}</div>`
    });
  } catch (error) {
    if (!["network_error", "timeout", "server_error", "busy"].includes(error.code)) forgetPendingId("liquidate", id);
    setGlobalLoader(false);
    await showPremiumModal({ icon: "warning", title: "Liquidación sin confirmar", text: `${error.message} Si hubo un problema de conexión, repite la operación para consultar el mismo pago.` });
  } finally {
    liquidationsInFlight.delete(id);
    setGlobalLoader(false);
  }
}


function setTimeLoader(isVisible){
  timeLoader.classList.toggle("visible", isVisible);
  timeLoader.setAttribute("aria-hidden", String(!isVisible));
}

function setGlobalLoader(isVisible, {
  title = "Procesando cambios",
  text = "Espera un momento mientras actualizamos la informacion."
} = {}){
  globalLoaderTitle.textContent = title;
  globalLoaderText.textContent = text;
  globalLoader.classList.toggle("visible", isVisible);
  globalLoader.setAttribute("aria-hidden", String(!isVisible));
}

function setCurrentRate(value){
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue) || numericValue <= 0){
    return;
  }

  currentHourRate = numericValue;
  renderCurrentRate(currentHourRate);
}

function normalizeWorker(worker = {}){
  return {
    id: worker.id || `temp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: worker.name || "Sin nombre",
    phone: worker.phone || "",
    email: worker.email || "",
    hourly_rate: getWorkerHourlyRate(worker),
    hours: Number(worker.hours || 0),
    pay: Number(worker.pay || 0),
    days: Number(worker.days || 0),
    active: parseWorkerActiveState(worker.active),
    hourlyRate: Number(worker.hourlyRate || currentHourRate || 0),
    activeRate: Number(worker.activeRate || 0),
    activeStart: worker.activeStart || "",
    lastLiquidation: worker.lastLiquidation || ""
  };
}

function getRateFromDashboard(dashboard){
  if (!dashboard || typeof dashboard !== "object"){
    return null;
  }

  if (Array.isArray(dashboard)){
    const rateFrequency = new Map();

    dashboard.forEach(worker => {
      const numericRate = Number(
        worker?.hourlyRate ?? worker?.hourly_rate ?? worker?.workerHourlyRate
      );

      if (Number.isFinite(numericRate) && numericRate > 0){
        rateFrequency.set(numericRate, (rateFrequency.get(numericRate) || 0) + 1);
      }
    });

    const mostFrequentRate = [...rateFrequency.entries()]
      .sort((a, b) => b[1] - a[1])[0];

    return mostFrequentRate?.[0] ?? null;
  }

  const directCandidates = [
    dashboard.rate,
    dashboard.hourRate,
    dashboard.hourlyRate,
    dashboard.valorHora,
    dashboard.valorhora,
    dashboard.rateValue,
    dashboard.currentRate,
    dashboard.tarifaHora,
    dashboard.tarifa
  ];

  for (const candidate of directCandidates){
    const numericValue = Number(candidate);
    if (Number.isFinite(numericValue) && numericValue > 0){
      return numericValue;
    }
  }

  for (const [key, value] of Object.entries(dashboard)){
    if (!/rate|hora|tarifa/i.test(key)){
      continue;
    }

    const numericValue = Number(value);
    if (Number.isFinite(numericValue) && numericValue > 0){
      return numericValue;
    }
  }

  return null;
}

function extractRateFromSettings(settingsResponse){
  if (!settingsResponse){
    return null;
  }

  if (Array.isArray(settingsResponse)){
    for (const row of settingsResponse){
      const numericValue = extractNumericSettingValue(row);
      if (numericValue !== null){
        return numericValue;
      }
    }
    return null;
  }

  return extractNumericSettingValue(settingsResponse);
}

function extractNumericSettingValue(row){
  if (row === null || row === undefined){
    return null;
  }

  if (typeof row === "number"){
    return Number.isFinite(row) && row > 0 ? row : null;
  }

  if (typeof row === "string"){
    const numericValue = Number(row);
    return Number.isFinite(numericValue) && numericValue > 0 ? numericValue : null;
  }

  if (typeof row !== "object"){
    return null;
  }

  const sheetName = String(row.sheet || row.sheetName || row.name || row.key || "").toLowerCase();
  const valueCandidates = [
    row.value,
    row.Value,
    row.valor,
    row.rate,
    row.hourRate
  ];

  if (!sheetName || /settings/.test(sheetName)){
    for (const candidate of valueCandidates){
      const numericValue = Number(candidate);
      if (Number.isFinite(numericValue) && numericValue > 0){
        return numericValue;
      }
    }
  }

  return null;
}

function insertOptimisticWorker(result, payload){
  const workerFromApi = result && typeof result === "object"
    ? {
        ...result,
        name: result.name || payload.name,
        phone: result.phone || payload.phone,
        email: result.email || payload.email
      }
    : payload;

  const optimisticWorker = normalizeWorker(workerFromApi);
  const exists = currentWorkers.some(worker =>
    String(worker.id) === String(optimisticWorker.id) ||
    (
      (worker.name || "").trim().toLowerCase() === optimisticWorker.name.trim().toLowerCase() &&
      (worker.phone || "").trim() === optimisticWorker.phone.trim() &&
      (worker.email || "").trim().toLowerCase() === optimisticWorker.email.trim().toLowerCase()
    )
  );

  if (!exists){
    currentWorkers = [optimisticWorker, ...currentWorkers.map(normalizeWorker)];
    renderWorkers(currentWorkers);
  }
}

function removeOptimisticWorker(id){
  currentWorkers = currentWorkers
    .filter(worker => String(worker.id) !== String(id))
    .map(normalizeWorker);
  renderWorkers(currentWorkers);
}

function updateOptimisticWorker(id, updates = {}){
  const workerId = String(id);
  currentWorkers = currentWorkers.map(worker =>
    String(worker.id) === workerId
      ? normalizeWorker({ ...worker, ...updates })
      : normalizeWorker(worker)
  );
  renderWorkers(currentWorkers);
}

function updateSelectedWorkerName(name){
  const selectedOption = workerSelect.options[workerSelect.selectedIndex];
  if (selectedOption && name){
    selectedOption.textContent = name;
  }
}

function updateTimeCaption(text){
  timeTableCaption.textContent = text;
}

function setHistoryLoader(isVisible){
  const historyLoader = document.getElementById("historyLoader");
  if (!historyLoader){
    return;
  }

  historyLoader.classList.toggle("visible", isVisible);
  historyLoader.setAttribute("aria-hidden", String(!isVisible));
}

function getHistoryElements(){
  return {
    historyTableBody: document.getElementById("historyTableBody"),
    historyCaption: document.getElementById("historyCaption"),
    historyWorkerFilter: document.getElementById("historyWorkerFilter"),
    historyDateFilter: document.getElementById("historyDateFilter"),
    historyDateSearch: document.getElementById("historyDateSearch"),
    historyDateSuggestions: document.getElementById("historyDateSuggestions"),
    historyTotalRecords: document.getElementById("historyTotalRecords"),
    historyTotalAmount: document.getElementById("historyTotalAmount")
  };
}

function getFilteredLiquidations(){
  const { historyWorkerFilter, historyDateFilter, historyDateSearch } = getHistoryElements();
  const selectedWorker = historyWorkerFilter?.value || "all";
  const selectedDay = historyDateFilter?.value || "all";
  const dateQuery = normalizeSearchText(historyDateSearch?.value || "");

  return liquidationHistory.filter(record => {
    const workerMatches = selectedWorker === "all" || String(record.workerId) === String(selectedWorker);
    if (!workerMatches){
      return false;
    }

    const dayKey = getLiquidationDayKey(record.liquidation_date);
    const dayMatches = selectedDay === "all" || dayKey === selectedDay;
    if (!dayMatches){
      return false;
    }

    if (!dateQuery){
      return true;
    }

    const searchableDate = normalizeSearchText(formatLiquidationDayLabel(record.liquidation_date));
    const searchableFullDate = normalizeSearchText(formatLiquidationDate(record.liquidation_date));
    return searchableDate.includes(dateQuery) || searchableFullDate.includes(dateQuery);
  });
}

function populateLiquidationWorkerFilter(records = []){
  const { historyWorkerFilter } = getHistoryElements();
  if (!historyWorkerFilter){
    return;
  }

  const previousValue = historyWorkerFilter.value || "all";
  const workersById = new Map();

  currentWorkers.forEach(worker => {
    workersById.set(String(worker.id), worker.name || "Sin nombre");
  });

  records.forEach(record => {
    const workerId = String(record.workerId || "").trim();
    if (!workerId){
      return;
    }

    workersById.set(workerId, record.workerName || workersById.get(workerId) || "Sin nombre");
  });

  const sortedOptions = [...workersById.entries()]
    .sort((a, b) => a[1].localeCompare(b[1], "es-CO"));

  historyWorkerFilter.innerHTML = `
    <option value="all">Todos los trabajadores</option>
    ${sortedOptions.map(([id, name]) => `<option value="${escapeHTML(id)}">${escapeHTML(name)}</option>`).join("")}
  `;

  const hasPrevious = previousValue === "all" || sortedOptions.some(([id]) => String(id) === String(previousValue));
  historyWorkerFilter.value = hasPrevious ? previousValue : "all";
}

function populateLiquidationDateFilter(records = []){
  const { historyDateFilter, historyDateSuggestions } = getHistoryElements();
  if (!historyDateFilter){
    return;
  }

  const previousValue = historyDateFilter.value || "all";
  const dayMap = new Map();

  records.forEach(record => {
    const dayKey = getLiquidationDayKey(record.liquidation_date);
    if (!dayKey){
      return;
    }

    dayMap.set(dayKey, formatLiquidationDayLabel(record.liquidation_date));
  });

  const sortedDays = [...dayMap.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]));

  historyDateFilter.innerHTML = `
    <option value="all">Todas las fechas</option>
    ${sortedDays.map(([key, label]) => `<option value="${escapeHTML(key)}">${escapeHTML(label)}</option>`).join("")}
  `;

  if (historyDateSuggestions){
    historyDateSuggestions.innerHTML = sortedDays
      .map(([, label]) => `<option value="${escapeHTML(label)}"></option>`)
      .join("");
  }

  const hasPrevious = previousValue === "all" || sortedDays.some(([key]) => key === previousValue);
  historyDateFilter.value = hasPrevious ? previousValue : "all";
}

function renderLiquidationsHistory(){
  const {
    historyTableBody,
    historyCaption,
    historyDateFilter,
    historyDateSearch,
    historyTotalRecords,
    historyTotalAmount
  } = getHistoryElements();

  if (!historyTableBody){
    return;
  }

  const filteredRecords = getFilteredLiquidations();
  const selectedWorkerName = document.getElementById("historyWorkerFilter")?.selectedOptions?.[0]?.text || "todos";
  const selectedDateName = historyDateFilter?.selectedOptions?.[0]?.text || "todas las fechas";
  const searchDateText = (historyDateSearch?.value || "").trim();

  if (!filteredRecords.length){
    historyTableBody.innerHTML = `<tr><td colspan="4" class="time-empty">No hay liquidaciones para el filtro seleccionado.</td></tr>`;
    if (historyCaption){
      historyCaption.textContent = `No se encontraron pagos para ${selectedWorkerName.toLowerCase()} en ${selectedDateName.toLowerCase()}${searchDateText ? ` que coincidan con "${searchDateText}"` : ""}.`;
    }
    if (historyTotalRecords){
      historyTotalRecords.textContent = "0";
    }
    if (historyTotalAmount){
      historyTotalAmount.textContent = formatCOP(0);
    }
    return;
  }

  historyTableBody.innerHTML = filteredRecords.map(record => `
    <tr>
      <td>${escapeHTML(record.workerName || "Sin nombre")}</td>
      <td>${formatLiquidationDate(record.liquidation_date)}</td>
      <td>${formatHoursValue(record.hours_paid || 0)} h</td>
      <td><span class="history-paid-chip">${formatCOP(record.amount_paid || 0)}</span></td>
    </tr>
  `).join("");

  const totalAmount = filteredRecords.reduce((acc, record) => acc + Number(record.amount_paid || 0), 0);

  if (historyCaption){
    historyCaption.textContent = `Mostrando ${filteredRecords.length} pagos para ${selectedWorkerName.toLowerCase()} en ${selectedDateName.toLowerCase()}${searchDateText ? ` filtrados por "${searchDateText}"` : ""}.`;
  }
  if (historyTotalRecords){
    historyTotalRecords.textContent = String(filteredRecords.length);
  }
  if (historyTotalAmount){
    historyTotalAmount.textContent = formatCOP(totalAmount);
  }
}

async function loadLiquidationsHistory({ showLoader = true, force = false } = {}){
  const { historyTableBody, historyCaption } = getHistoryElements();
  if (!historyTableBody){
    return [];
  }

  if (showLoader){
    setHistoryLoader(true);
  }

  try {
    const response = await api("getLiquidations", {}, {
      cacheMs: READ_CACHE_MS,
      force: force || showLoader
    });
    applyLiquidationHistory(response);
    return liquidationHistory;
  } catch (error){
    liquidationHistory = [];
    historyTableBody.innerHTML = `<tr><td colspan="4" class="time-empty">No fue posible cargar el historial en este momento.</td></tr>`;
    if (historyCaption){
      historyCaption.textContent = "Hubo un problema al cargar el historial de liquidaciones.";
    }
    return [];
  } finally {
    setHistoryLoader(false);
  }
}

async function refreshLiquidationsHistory(){
  await loadLiquidationsHistory({ showLoader: true });
}

workerSelect.addEventListener("change", () => {
  if (attendanceMode === "multi" && selectedBatchWorkers.size === 0 && workerSelect.value){
    selectedBatchWorkers.add(String(workerSelect.value));
    renderMultiWorkerList(currentWorkers);
  }

  renderActiveShift();
  loadTimeLogs({ showLoader: true });
});

const historyWorkerFilter = document.getElementById("historyWorkerFilter");
if (historyWorkerFilter){
  historyWorkerFilter.addEventListener("change", () => {
    renderLiquidationsHistory();
  });
}

const historyDateFilter = document.getElementById("historyDateFilter");
if (historyDateFilter){
  historyDateFilter.addEventListener("change", () => {
    renderLiquidationsHistory();
  });
}

const historyDateSearch = document.getElementById("historyDateSearch");
if (historyDateSearch){
  historyDateSearch.addEventListener("input", () => {
    renderLiquidationsHistory();
  });
}



function renderTimeLogs(logs = displayedLogs){
  const workerName = workerSelect.selectedOptions[0]?.text || "el trabajador";
  const valid = Array.isArray(logs) ? logs : [];
  timeLogsTable.innerHTML = valid.length ? valid.map(log => {
    const format = value => new Date(value).toLocaleString("es-CO", { timeZone: "America/Bogota", weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
    return `<tr><td>${escapeHTML(log.workerName || workerName)}</td><td><span class="time-chip time-chip-in">${escapeHTML(format(log.start))}</span></td><td><span class="time-chip ${log.end ? "time-chip-out" : "time-chip-pending"}">${log.end ? escapeHTML(format(log.end)) : "Pendiente"}</span></td><td>${log.end ? `<span class="status-out">FUERA DE TURNO</span><small class="log-earnings">${formatHoursValue(log.hours)} h · ${formatCOP(log.earned)}</small>` : '<span class="active-dot">EN TURNO</span>'}</td></tr>`;
  }).join("") : '<tr><td colspan="4" class="time-empty">No hay marcajes para mostrar.</td></tr>';
  updateTimeCaption(workerSelect.value ? `Mostrando ${valid.length} marcajes de ${workerName}. Horario de Colombia.` : "Agrega trabajadores desde la sección Trabajadores para comenzar.");
  const more = document.getElementById("moreLogsButton");
  more.hidden = !hasMoreLogs || !document.getElementById("time").classList.contains("active");
}

async function loadTimeLogs({ showLoader = true, force = false, more = false } = {}){
  const workerId = String(workerSelect.value || "");
  const sequence = ++logsSequence;
  const epoch = dataEpoch;
  if (!workerId) { displayedLogs = []; hasMoreLogs = false; renderTimeLogs(); return; }
  if (showLoader) setTimeLoader(true);
  try {
    const result = await api("getTimeLogsByWorker", { worker: workerId, offset: more ? displayedLogs.length : 0, limit: 100 }, { cacheMs: FAST_CACHE_MS, force });
    if (sequence !== logsSequence || workerSelect.value !== workerId || epoch !== dataEpoch) return;
    displayedLogs = more ? [...displayedLogs, ...result.logs] : result.logs;
    hasMoreLogs = Boolean(result.hasMore);
    renderTimeLogs();
  } catch (error) {
    if (sequence === logsSequence) updateTimeCaption(error.message);
  } finally { if (sequence === logsSequence) setTimeLoader(false); }
}

async function loadMoreLogs(){
  const button = document.getElementById("moreLogsButton");
  button.disabled = true;
  try { await loadTimeLogs({ more: true, force: true }); } finally { button.disabled = false; }
}


function setConnectionStatus(text, state = "offline"){
  const status = document.getElementById("connectionStatus");
  status.textContent = text;
  status.dataset.state = state;
}

async function fetchFrom(url, payload){
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 35000);
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(payload), cache: "no-store", signal: controller.signal, redirect: "follow" });
    if (!response.ok) { const error = new Error(`No se pudo contactar el servicio. Intenta nuevamente en un momento.`); error.code = "network_error"; throw error; }
    let result;
    try { result = JSON.parse(await response.text()); }
    catch (_) { const error = new Error("El servicio no está disponible en este momento. Intenta nuevamente más tarde."); error.code = "invalid_response"; throw error; }
    if (!result || typeof result !== "object") throw new Error("La respuesta del servidor no es válida.");
    if (result.error) { const error = new Error(result.message || "No se pudo completar la operación."); error.code = result.code || "server_error"; throw error; }
    return result;
  } catch (error) {
    if (error.name === "AbortError") { const timeoutError = new Error("La confirmación tardó demasiado."); timeoutError.code = "timeout"; throw timeoutError; }
    if (!error.code && error instanceof TypeError) error.code = "network_error";
    throw error;
  } finally { clearTimeout(timeout); }
}

function validApiUrl(value){
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname === "script.google.com" && /^\/macros\/s\/[\w-]+\/exec$/.test(url.pathname) && !url.search && !url.hash;
  } catch (_) { return false; }
}

function lockAdmin(notifyServer = true){
  const token = adminToken;
  adminToken = "";
  adminUnlocked = false;
  readCache.clear();
  document.getElementById("lockAdminButton").hidden = true;
  setActiveSectionUI("time");
  if (notifyServer && token && apiUrl) void fetchFrom(apiUrl, { action: "logout", token }).catch(() => {});
}

function toggleTheme(){
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem("zoe-theme", next); } catch (_) {}
  updateThemeButton();
}

function updateThemeButton(){
  const dark = document.documentElement.dataset.theme === "dark";
  const button = document.getElementById("themeToggle");
  button.textContent = dark ? "☀ Modo día" : "☾ Modo noche";
  button.setAttribute("aria-label", dark ? "Activar modo día" : "Activar modo noche");
  document.querySelector('meta[name="theme-color"]').content = dark ? "#102b50" : "#ffffff";
}

function durationText(start){
  const total = Math.max(0, Math.floor((Date.now() + serverOffset - new Date(start).getTime()) / 1000));
  return `${String(Math.floor(total / 3600)).padStart(2, "0")}:${String(Math.floor(total / 60) % 60).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function renderActiveShift(){
  const panel = document.getElementById("activeShiftPanel");
  const worker = currentWorkers.find(w => String(w.id) === String(workerSelect.value));
  if (!worker) { panel.innerHTML = '<span class="shift-state">Selecciona o registra un trabajador para comenzar.</span>'; return; }
  panel.innerHTML = worker.active
    ? `<div><span class="shift-state"><i></i> EN TURNO</span><strong>${escapeHTML(worker.name)}</strong><small>Entrada ${formatAttendanceTime(worker.activeStart)}</small></div><div class="shift-clock"><strong class="liveClock" data-start="${escapeHTML(worker.activeStart)}">${durationText(worker.activeStart)}</strong><small class="liveEstimate" data-start="${escapeHTML(worker.activeStart)}" data-rate="${Number(worker.activeRate)}"></small></div>`
    : `<div><span class="shift-state">FUERA DE TURNO</span><strong>${escapeHTML(worker.name)}</strong><small>Listo para registrar una nueva entrada</small></div><span class="shift-placeholder">— — : — —</span>`;
  tickClocks();
}

function tickClocks(){
  document.querySelectorAll(".liveTimer, .liveClock").forEach(el => { el.textContent = `${el.classList.contains("liveTimer") ? "Tiempo en turno: " : ""}${durationText(el.dataset.start)}`; });
  document.querySelectorAll(".liveEstimate").forEach(el => {
    const hours = Math.max(0, (Date.now() + serverOffset - new Date(el.dataset.start).getTime()) / 3600000);
    el.textContent = `Estimado ${formatCOP(hours * Number(el.dataset.rate))}`;
  });
}

window.addEventListener("unhandledrejection", event => {
  event.preventDefault();
  setGlobalLoader(false);
  console.error(event.reason);
  void showPremiumModal({ icon: "error", title: "No se pudo completar", text: event.reason?.message || "Revisa la conexión e intenta nuevamente." });
});

let syncBusy = false;
async function syncVisible(){
  if (document.hidden || !apiUrl || attendanceBusy || timeSectionLoading || syncBusy || navigator.onLine === false) return;
  syncBusy = true;
  try {
    const section = document.querySelector(".section.active")?.id;
    if (section === "time") await loadTimeSection();
    else if (section === "workers") await loadWorkers({ force: true });
    else if (section === "dashboard" && adminUnlocked) await loadDashboard({ force: true });
  } catch (error) { setConnectionStatus(error.message, "error"); }
  finally { syncBusy = false; }
}

try { apiUrl = window.ZOE_CONFIG?.apiUrl?.trim() || ""; }
catch (_) { apiUrl = window.ZOE_CONFIG?.apiUrl?.trim() || ""; }
if (!validApiUrl(apiUrl)) apiUrl = "";
document.getElementById("todayLabel").textContent = new Date().toLocaleDateString("es-CO", { timeZone: "America/Bogota", timeZone: "America/Bogota", weekday: "long", day: "numeric", month: "long", year: "numeric" });
updateThemeButton();
setAttendanceMode("single");
renderActiveShift();
setAttendanceButtonsBusy(false);
if (apiUrl) void loadTimeSection(); else renderTimeLogs([]);
setInterval(tickClocks, 1000);
setInterval(syncVisible, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden) void syncVisible(); });
window.addEventListener("online", () => void syncVisible());
window.addEventListener("offline", () => setConnectionStatus("Sin conexión · los marcajes requieren internet", "offline"));

let installPrompt = null, pendingServiceWorker = null;
window.addEventListener("beforeinstallprompt", event => {
  event.preventDefault(); installPrompt = event;
  document.getElementById("installButton").hidden = false;
});
window.addEventListener("appinstalled", () => {
  installPrompt = null; document.getElementById("installButton").hidden = true;
});
async function installApp(){
  if (installPrompt) {
    await installPrompt.prompt();
    const choice = await installPrompt.userChoice;
    if (choice.outcome === "accepted") document.getElementById("installButton").hidden = true;
    installPrompt = null;
    return;
  }
  await showPremiumModal({ title: "Instalar Zoe Fragance", text: "En Safari, toca Compartir y elige Agregar a pantalla de inicio." });
}
function updateApp(){
  if (attendanceBusy || liquidationsInFlight.size) return;
  pendingServiceWorker?.postMessage("ACTIVATE_UPDATE");
}
if ("serviceWorker" in navigator && ["http:", "https:"].includes(location.protocol)) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then(registration => {
      const offerUpdate = () => {
        if (registration.waiting) {
          pendingServiceWorker = registration.waiting;
          document.getElementById("updateButton").hidden = false;
        }
      };
      offerUpdate();
      registration.addEventListener("updatefound", () => {
        registration.installing?.addEventListener("statechange", offerUpdate);
      });
    }).catch(error => console.error("No se pudo preparar la instalación", error));
  });
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (pendingServiceWorker && !reloading) { reloading = true; location.reload(); }
  });
}
if (/iPad|iPhone|iPod/.test(navigator.userAgent) && !navigator.standalone && !matchMedia("(display-mode: standalone)").matches) {
  document.getElementById("installButton").hidden = false;
}

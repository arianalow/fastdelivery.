'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
let complaints = [];
let activeFolio = null;
let toastTimer;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
}
function formatDate(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat('es-MX', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' }).format(date);
}
function slugStatus(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, '-');
}
function showToast(message, error = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.className = `toast show${error ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.className = 'toast', 3200);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { ...(options.body ? {'Content-Type':'application/json'} : {}), ...(options.headers || {}) },
    ...options,
  });
  if (response.status === 401 && path !== '/api/login') {
    showLogin();
    throw new Error('Tu sesión terminó. Inicia sesión nuevamente.');
  }
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : null;
  if (!response.ok) throw new Error(data?.error || 'Ocurrió un error al procesar la solicitud.');
  return data;
}
function showLogin() {
  $('#appPage').classList.add('hidden');
  $('#loginPage').classList.remove('hidden');
  $('#loginForm').reset();
  $('#loginError').textContent = '';
}
function showApp(user) {
  $('#loginPage').classList.add('hidden');
  $('#appPage').classList.remove('hidden');
  $('#userName').textContent = user || 'Administrador';
  refreshComplaints().catch(error => showToast(error.message, true));
}
async function checkSession() {
  try {
    const data = await api('/api/me');
    showApp(data.user);
  } catch { showLogin(); }
}
async function refreshComplaints() {
  const data = await api('/api/complaints');
  complaints = data.complaints || [];
  renderDashboard();
}
function renderDashboard() {
  const total = complaints.length;
  const resolved = complaints.filter(item => ['Resuelta','Cerrada'].includes(item.status)).length;
  const analysis = complaints.filter(item => item.status === 'En análisis').length;
  const pending = total - resolved;
  $('#statTotal').textContent = total;
  $('#statPending').textContent = pending;
  $('#statAnalysis').textContent = analysis;
  $('#statResolved').textContent = resolved;
  renderTable();
}
function renderTable() {
  const query = $('#searchInput').value.trim().toLowerCase();
  const status = $('#statusFilter').value;
  const category = $('#categoryFilter').value;
  const filtered = complaints.filter(item => {
    const searchable = [item.folio,item.customerName,item.guideNumber,item.email,item.phone].join(' ').toLowerCase();
    return (!query || searchable.includes(query)) && (!status || item.status === status) && (!category || item.category === category);
  });
  $('#resultsCount').textContent = `${filtered.length} ${filtered.length === 1 ? 'reclamación' : 'reclamaciones'}`;
  const body = $('#complaintsBody');
  if (!filtered.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty-cell">${complaints.length ? 'No hay resultados con esos filtros.' : 'Aún no hay quejas registradas. Selecciona “Nueva queja” para comenzar.'}</td></tr>`;
    return;
  }
  body.innerHTML = filtered.map(item => `
    <tr data-folio="${escapeHtml(item.folio)}" tabindex="0" aria-label="Abrir reclamación ${escapeHtml(item.folio)}">
      <td><span class="folio">${escapeHtml(item.folio)}</span><span class="subtext">Guía ${escapeHtml(item.guideNumber)}</span></td>
      <td><span class="customer-name">${escapeHtml(item.customerName)}</span><span class="subtext">${escapeHtml(item.channel)}</span></td>
      <td>${escapeHtml(item.category)}</td>
      <td>${escapeHtml(formatDate(item.createdAt))}</td>
      <td>${escapeHtml(item.assignedArea)}</td>
      <td><span class="status-badge status-${slugStatus(item.status)}">${escapeHtml(item.status)}</span></td>
      <td class="row-arrow">›</td>
    </tr>`).join('');
}
function openModal(id) { $(`#${id}`).classList.remove('hidden'); }
function closeModal(id) { $(`#${id}`).classList.add('hidden'); }
async function openDetail(folio) {
  activeFolio = folio;
  $('#detailContent').innerHTML = '<p class="muted">Cargando expediente...</p>';
  $('#updateForm').classList.add('hidden');
  openModal('detailModal');
  try {
    const { complaint } = await api(`/api/complaints/${encodeURIComponent(folio)}`);
    $('#detailTitle').textContent = 'Detalle de reclamación';
    $('#detailSubtitle').textContent = `Registrada el ${formatDate(complaint.createdAt)}`;
    $('#updateForm [name="status"]').value = complaint.status;
    $('#updateForm [name="assignedArea"]').value = complaint.assignedArea;
    $('#updateForm [name="solution"]').value = complaint.solution || '';
    $('#updateForm [name="note"]').value = '';
    $('#detailContent').innerHTML = `
      <div class="detail-header-row"><span class="detail-folio">${escapeHtml(complaint.folio)}</span><span class="status-badge status-${slugStatus(complaint.status)}">${escapeHtml(complaint.status)}</span></div>
      <div class="detail-grid">
        <div class="detail-item"><label>Cliente</label><div>${escapeHtml(complaint.customerName)}</div></div>
        <div class="detail-item"><label>Número de guía</label><div>${escapeHtml(complaint.guideNumber)}</div></div>
        <div class="detail-item"><label>Teléfono</label><div>${escapeHtml(complaint.phone || 'No proporcionado')}</div></div>
        <div class="detail-item"><label>Correo</label><div>${escapeHtml(complaint.email || 'No proporcionado')}</div></div>
        <div class="detail-item"><label>Motivo</label><div>${escapeHtml(complaint.category)}</div></div>
        <div class="detail-item"><label>Canal de recepción</label><div>${escapeHtml(complaint.channel)}</div></div>
        <div class="detail-item"><label>Área responsable</label><div>${escapeHtml(complaint.assignedArea)}</div></div>
        <div class="detail-item"><label>Última actualización</label><div>${escapeHtml(formatDate(complaint.updatedAt))}</div></div>
        <div class="detail-item full-span"><label>Descripción del problema</label><div>${escapeHtml(complaint.description).replace(/\n/g,'<br>')}</div></div>
        <div class="detail-item full-span"><label>Solución registrada</label><div>${escapeHtml(complaint.solution || 'Aún no se registra una solución.').replace(/\n/g,'<br>')}</div></div>
      </div>
      <div class="timeline"><h3>Historial de seguimiento</h3>${(complaint.updates || []).length ? complaint.updates.map(update => `
        <div class="timeline-item"><span class="timeline-dot"></span><div><b>${escapeHtml(update.kind)}</b><p>${escapeHtml(update.message)}</p><small>${escapeHtml(update.actor)} · ${escapeHtml(formatDate(update.createdAt))}</small></div></div>`).join('') : '<p class="muted">Sin movimientos.</p>'}</div>`;
    $('#updateForm').classList.remove('hidden');
  } catch (error) { showToast(error.message, true); }
}

$('#loginForm').addEventListener('submit', async event => {
  event.preventDefault();
  const form = new FormData(event.currentTarget);
  const button = $('button[type="submit"]', event.currentTarget);
  button.disabled = true;
  $('#loginError').textContent = '';
  try {
    const data = await api('/api/login', { method:'POST', body:JSON.stringify({ username:form.get('username'), password:form.get('password') }) });
    showApp(data.user);
  } catch (error) { $('#loginError').textContent = error.message; }
  finally { button.disabled = false; }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method:'POST', body:'{}' }); } catch {}
  showLogin();
});
$('#newComplaintBtn').addEventListener('click', () => { $('#complaintForm').reset(); openModal('complaintModal'); });
$('#complaintForm').addEventListener('submit', async event => {
  event.preventDefault();
  const button = $('button[type="submit"]', event.currentTarget);
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  button.disabled = true;
  try {
    const data = await api('/api/complaints', { method:'POST', body:JSON.stringify(values) });
    closeModal('complaintModal');
    await refreshComplaints();
    showToast(`Queja registrada. Folio: ${data.complaint.folio}`);
    await openDetail(data.complaint.folio);
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});
$('#updateForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (!activeFolio) return;
  const button = $('button[type="submit"]', event.currentTarget);
  const values = Object.fromEntries(new FormData(event.currentTarget).entries());
  button.disabled = true;
  try {
    await api(`/api/complaints/${encodeURIComponent(activeFolio)}`, { method:'PATCH', body:JSON.stringify(values) });
    await refreshComplaints();
    await openDetail(activeFolio);
    showToast('Seguimiento actualizado correctamente.');
  } catch (error) { showToast(error.message, true); }
  finally { button.disabled = false; }
});
$('#complaintsBody').addEventListener('click', event => {
  const row = event.target.closest('tr[data-folio]');
  if (row) openDetail(row.dataset.folio);
});
$('#complaintsBody').addEventListener('keydown', event => {
  if (event.key === 'Enter' || event.key === ' ') {
    const row = event.target.closest('tr[data-folio]');
    if (row) { event.preventDefault(); openDetail(row.dataset.folio); }
  }
});
['searchInput','statusFilter','categoryFilter'].forEach(id => $(`#${id}`).addEventListener(id === 'searchInput' ? 'input' : 'change', renderTable));
$('#exportBtn').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/export.csv', { credentials:'same-origin' });
    if (response.status === 401) { showLogin(); throw new Error('Inicia sesión nuevamente.'); }
    if (!response.ok) throw new Error('No fue posible exportar los registros.');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = 'fastdelivery-quejas.csv'; link.click();
    URL.revokeObjectURL(url);
  } catch (error) { showToast(error.message, true); }
});
$$('[data-close]').forEach(button => button.addEventListener('click', () => closeModal(button.dataset.close)));
$('#navDashboard').addEventListener('click', () => { $('#pageTitle').textContent = 'Panel de control'; window.scrollTo({top:0,behavior:'smooth'}); });
$('#navComplaints').addEventListener('click', () => { $('#pageTitle').textContent = 'Reclamaciones'; $('#complaintsSection').scrollIntoView({behavior:'smooth'}); });

checkSession();
setInterval(() => {
  if (!$('#appPage').classList.contains('hidden')) refreshComplaints().catch(() => {});
}, 30000);

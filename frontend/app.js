const API = 'http://localhost:5000';
const MAX_SIZE_MB = 5;
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp'];
const REFRESH_MS = 14 * 60 * 1000; // renueva las URLs antes de que expiren (15 min)

const $ = id => document.getElementById(id);
const fileInput = $('file');
const dropzone = $('dropzone');
const dzEmpty = $('dzEmpty');
const dzPreview = $('dzPreview');
const previewImg = $('previewImg');
const previewName = $('previewName');
const previewMeta = $('previewMeta');
const uploadBtn = $('uploadBtn');
const clearBtn = $('clearBtn');
const progressWrap = $('progressWrap');
const progressBar = $('progressBar');
const gallery = $('gallery');
const countEl = $('count');
const emptyEl = $('empty');
const emptyTitle = $('emptyTitle');
const emptyText = $('emptyText');
const searchEl = $('search');
const sortEl = $('sort');
const refreshBtn = $('refreshBtn');

let items = [];
let previewUrl = null;

const TRASH_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 12a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-12M9 7V4h6v3"/></svg>';

/* ---------- utilidades ---------- */
function toast(msg, type = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function formatDate(iso) {
  return new Date(iso).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' });
}

function displayName(key) {
  return key.replace('originales/', '').replace(/^\d+-[0-9a-f]{12}-/, '');
}

function validateFile(file) {
  if (!ALLOWED.includes(file.type)) return 'Tipo no permitido. Solo JPG, PNG o WEBP.';
  if (file.size > MAX_SIZE_MB * 1024 * 1024) return 'Archivo demasiado grande (máx. 5 MB).';
  if (file.size === 0) return 'El archivo está vacío.';
  return null;
}

/* ---------- selección y vista previa ---------- */
function clearSelection() {
  fileInput.value = '';
  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = null;
  dzPreview.hidden = true;
  dzEmpty.hidden = false;
  clearBtn.hidden = true;
  progressWrap.hidden = true;
  progressBar.style.width = '0';
}

function showSelected() {
  const file = fileInput.files[0];
  if (!file) return clearSelection();

  const error = validateFile(file);
  if (error) {
    clearSelection();
    return toast(error, 'error');
  }

  if (previewUrl) URL.revokeObjectURL(previewUrl);
  previewUrl = URL.createObjectURL(file);
  previewImg.src = previewUrl;
  previewName.textContent = file.name;
  previewMeta.textContent = `${file.type.replace('image/', '').toUpperCase()} · ${formatSize(file.size)}`;
  dzEmpty.hidden = true;
  dzPreview.hidden = false;
  clearBtn.hidden = false;
}

fileInput.addEventListener('change', showSelected);
clearBtn.addEventListener('click', clearSelection);

['dragenter', 'dragover'].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  })
);
['dragleave', 'drop'].forEach(evt =>
  dropzone.addEventListener(evt, e => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
  })
);
dropzone.addEventListener('drop', e => {
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    showSelected();
  }
});

/* ---------- subida directa a S3 con progreso ---------- */
function putToS3(url, file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = e => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`S3 rechazó la subida (${xhr.status})`));
    xhr.onerror = () => reject(new Error('Error de red al subir a S3'));
    xhr.send(file);
  });
}

uploadBtn.addEventListener('click', async () => {
  const file = fileInput.files[0];
  if (!file) return toast('Selecciona un archivo primero', 'error');

  const error = validateFile(file);
  if (error) return toast(error, 'error');

  uploadBtn.disabled = true;
  clearBtn.disabled = true;
  progressWrap.hidden = false;
  progressBar.style.width = '0';
  uploadBtn.textContent = 'Subiendo...';

  try {
    // 1) Pedir la presigned URL al backend
    const res = await fetch(`${API}/api/upload-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size
      })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error del backend');

    // 2) PUT directo a S3 (el archivo no pasa por el backend)
    await putToS3(data.uploadUrl, file, p => {
      progressBar.style.width = Math.round(p * 100) + '%';
    });

    toast('Imagen subida correctamente', 'ok');
    clearSelection();
    await loadGallery();
  } catch (err) {
    toast(err.message, 'error');
    progressWrap.hidden = true;
  } finally {
    uploadBtn.disabled = false;
    clearBtn.disabled = false;
    uploadBtn.textContent = 'Subir a S3';
  }
});

/* ---------- galería ---------- */
function showSkeleton() {
  gallery.innerHTML = '';
  for (let i = 0; i < 4; i++) {
    const s = document.createElement('div');
    s.className = 'skeleton';
    gallery.appendChild(s);
  }
  emptyEl.hidden = true;
}

async function loadGallery(first = false) {
  if (first) showSkeleton();
  try {
    const res = await fetch(`${API}/api/images`);
    if (!res.ok) throw new Error('El backend respondió ' + res.status);
    items = await res.json();
    render();
  } catch (err) {
    gallery.innerHTML = '';
    toast('No se pudo cargar la galería: ' + err.message, 'error');
  }
}

function render() {
  const term = searchEl.value.trim().toLowerCase();
  let list = items.filter(i => displayName(i.key).toLowerCase().includes(term));

  const sort = sortEl.value;
  if (sort === 'name') list.sort((a, b) => displayName(a.key).localeCompare(displayName(b.key)));
  else if (sort === 'size') list.sort((a, b) => b.size - a.size);
  else list.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));

  // estadísticas
  $('statCount').textContent = items.length;
  $('statSize').textContent = formatSize(items.reduce((sum, i) => sum + i.size, 0));
  countEl.textContent = items.length ? `(${list.length} de ${items.length})` : '';

  // vacío
  emptyEl.hidden = list.length > 0;
  if (!list.length) {
    if (items.length) {
      emptyTitle.textContent = 'Sin resultados';
      emptyText.textContent = 'Prueba con otro término de búsqueda.';
    } else {
      emptyTitle.textContent = 'Aún no hay imágenes';
      emptyText.textContent = 'Sube la primera usando el recuadro de arriba.';
    }
  }

  gallery.innerHTML = '';
  list.forEach(item => gallery.appendChild(buildCard(item)));
}

function buildCard(item) {
  const name = displayName(item.key);

  const card = document.createElement('div');
  card.className = 'item';

  const thumb = document.createElement('button');
  thumb.className = 'thumb';
  thumb.type = 'button';
  thumb.title = 'Ver imagen';
  const img = document.createElement('img');
  img.src = item.url;
  img.alt = name;
  img.loading = 'lazy';
  img.onerror = () => thumb.classList.add('broken');
  thumb.appendChild(img);
  thumb.addEventListener('click', () => openLightbox(item));

  const body = document.createElement('div');
  body.className = 'item-body';

  const nameEl = document.createElement('div');
  nameEl.className = 'item-name';
  nameEl.textContent = name;

  const meta = document.createElement('div');
  meta.className = 'item-meta';
  meta.textContent = `${formatSize(item.size)} · ${formatDate(item.lastModified)}`;

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  const del = document.createElement('button');
  del.className = 'btn danger';
  del.innerHTML = TRASH_SVG + ' Eliminar';
  del.addEventListener('click', () => deleteImage(item, del));
  actions.appendChild(del);

  body.append(nameEl, meta, actions);
  card.append(thumb, body);
  return card;
}

searchEl.addEventListener('input', render);
sortEl.addEventListener('change', render);
refreshBtn.addEventListener('click', async () => {
  await loadGallery();
  toast('Galería actualizada');
});

/* ---------- visor ---------- */
const lightbox = $('lightbox');

function openLightbox(item) {
  $('lbImg').src = item.url;
  $('lbImg').alt = displayName(item.key);
  $('lbName').textContent = displayName(item.key);
  $('lbMeta').textContent = `${formatSize(item.size)} · ${formatDate(item.lastModified)}`;
  $('lbOpen').href = item.url;
  lightbox.hidden = false;
}
function closeLightbox() {
  lightbox.hidden = true;
  $('lbImg').src = '';
}
$('lbClose').addEventListener('click', closeLightbox);
lightbox.addEventListener('click', e => { if (e.target === lightbox) closeLightbox(); });

/* ---------- confirmación y borrado ---------- */
function askConfirm(text) {
  return new Promise(resolve => {
    const box = $('confirm');
    $('confirmText').textContent = text;
    box.hidden = false;
    const done = result => {
      box.hidden = true;
      $('confirmYes').onclick = null;
      $('confirmNo').onclick = null;
      resolve(result);
    };
    $('confirmYes').onclick = () => done(true);
    $('confirmNo').onclick = () => done(false);
  });
}

async function deleteImage(item, btn) {
  const ok = await askConfirm(displayName(item.key));
  if (!ok) return;

  btn.disabled = true;
  try {
    const path = item.key.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(`${API}/api/images/${path}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('Respuesta ' + res.status);
    toast('Imagen eliminada', 'ok');
    await loadGallery();
  } catch (err) {
    btn.disabled = false;
    toast('No se pudo eliminar: ' + err.message, 'error');
  }
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    closeLightbox();
    if (!$('confirm').hidden) $('confirmNo').click();
  }
});

/* ---------- inicio ---------- */
loadGallery(true);
setInterval(() => loadGallery(), REFRESH_MS);
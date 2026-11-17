const $ = (id) => document.getElementById(id);
let chosen = null;

function setFile(f) {
  chosen = f;
  $('go').disabled = !f;
  $('status').textContent = f ? `${f.name} · ${(f.size / 1024).toFixed(0)} KB` : '';
}
$('file').addEventListener('change', (e) => setFile(e.target.files[0] || null));
const drop = $('drop');
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => setFile(e.dataTransfer.files[0] || null));

$('go').addEventListener('click', async () => {
  if (!chosen) return;
  $('go').disabled = true;
  $('result').hidden = true;
  $('status').textContent = 'Uploading and processing…';
  try {
    const text = await chosen.text();
    const r = await api('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain', 'x-filename': chosen.name },
      body: text,
    });
    try { localStorage.setItem('sla.upload', r.uploadId); } catch {}
    $('status').textContent = r.alreadyUploaded ? 'This exact file was already uploaded — showing the existing dataset.' : 'Done.';
    $('result-body').innerHTML = dataQualityHtml(r.summary);
    $('open').href = `./?upload=${encodeURIComponent(r.uploadId)}`;
    $('result').hidden = false;
  } catch (e) {
    $('status').innerHTML = `<span class="error" style="padding:0">${esc(e.message)}</span>`;
  } finally {
    $('go').disabled = false;
  }
});

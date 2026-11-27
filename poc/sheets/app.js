// 코웍-코인 · 구글 시트 연결 시제품 (앱과 분리된 시험 페이지)
//   비공개 원칙: 시트 내용(품목 · 사용처 · 메모 · 금액)은 화면에만 표시 — fetch 로 구글 외 주소에 보내지 않고, console 에 찍지 않고, 저장소에 넣지 않음
//   sessionStorage 에는 시험 결과(성공/실패) · 연결한 파일 ID · 로그인 확인용 임시값(state)만 둠 — 탭을 닫으면 사라짐
//   구글 로그인 토큰은 메모리에만 둠 (이동 방식은 주소창 # 뒤로 돌아오므로 받자마자 주소에서 지움)
(() => {
  'use strict';

  const SCOPE = 'https://www.googleapis.com/auth/drive.file';
  const SHEET_TITLE = '집행';
  const HEADER = ['날짜', '예산', '프로젝트', '품목', '금액', '사용처', '메모', '행 ID'];
  const BUDGETS = ['업무비', '회의비', '프로젝트'];
  const SS_KEY = 'cwc-sheets-poc';
  const cfg = window.POC_CONFIG || null;
  const configured = !!(cfg && cfg.clientId && cfg.apiKey && cfg.appId);
  // 이동 방식 로그인의 돌아올 주소 — OAuth 클라이언트에 등록한 주소와 글자까지 같아야 함
  const REDIRECT_URI = location.origin + '/poc/sheets/index.html';

  const $ = id => document.getElementById(id);

  // ---------------------------------------------------------------- 상태 (토큰은 메모리에만)
  let token = null;
  let tokenExp = 0;
  let tokenClient = null;
  let pickerReady = null;

  const CHECKS = [
    ['loginPopup', '팝업 방식 로그인'],
    ['loginRedirect', '이동 방식 로그인'],
    ['create', '새 시트 만들기'],
    ['pick', '구글 창에서 기존 시트 고르기'],
    ['match', '고른 시트와 붙여 넣은 링크 일치'],
    ['append', '시트에 행 쓰기'],
    ['read', '시트 읽고 월별 합계 계산'],
    ['restricted', '시트 공유 상태 확인'],
  ];

  function loadSession() {
    try { return JSON.parse(sessionStorage.getItem(SS_KEY) || '{}'); } catch { return {}; }
  }
  const session = Object.assign({ results: {}, fileId: null, state: null }, loadSession());
  function saveSession() {
    try { sessionStorage.setItem(SS_KEY, JSON.stringify(session)); } catch { /* 저장소를 못 쓰면 이 화면 동안만 유지 */ }
  }
  function setResult(key, ok, code) {
    session.results[key] = { ok, code: code || '' };
    saveSession();
    renderChecks();
  }

  // ---------------------------------------------------------------- 화면 도우미
  function status(id, text, kind) {
    const el = $(id);
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
  }
  function standalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }
  function deviceLabel() {
    const ua = navigator.userAgent;
    const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android'
      : /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : '기타';
    const br = /CriOS/.test(ua) ? 'Chrome(iOS)' : /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? '삼성 인터넷'
      : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /Firefox\//.test(ua) ? 'Firefox' : '기타';
    return `${os} · ${br}`;
  }
  function renderEnv() {
    $('envMode').textContent = standalone() ? '설치 앱 (홈 화면 아이콘)' : '브라우저 탭';
    $('envDevice').textContent = deviceLabel();
    $('envOrigin').textContent = location.origin;
    if (standalone()) $('installHint').classList.add('hidden');
  }
  function renderChecks() {
    const ul = $('checks');
    ul.textContent = '';
    for (const [key, label] of CHECKS) {
      const r = session.results[key];
      const li = document.createElement('li');
      const mark = document.createElement('span');
      mark.className = 'mark ' + (!r ? 'none' : r.ok ? 'ok' : 'bad');
      mark.textContent = !r ? '–' : r.ok ? '✓' : '✗';
      const text = document.createElement('span');
      text.textContent = label + (r && !r.ok && r.code ? ` (${r.code})` : '');
      li.append(mark, text);
      ul.append(li);
    }
  }
  function renderButtons() {
    const live = !!token && Date.now() < tokenExp;
    $('btnCreate').disabled = !live;
    $('btnPick').disabled = !live;
    $('btnRevoke').disabled = !live;
    const hasFile = live && !!session.fileId;
    $('btnAppend').disabled = !hasFile;
    $('btnRead').disabled = !hasFile;
    $('btnPopup').disabled = !configured;
    $('btnRedirect').disabled = !configured;
  }

  // ---------------------------------------------------------------- 구글 API (토큰으로 브라우저가 직접 호출)
  async function gfetch(url, opts = {}) {
    if (!token || Date.now() >= tokenExp) throw Object.assign(new Error('로그인이 만료됐습니다. 다시 로그인해 주세요'), { code: 'token_expired' });
    const res = await fetch(url, {
      ...opts,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', ...(opts.headers || {}) },
      cache: 'no-store',
    });
    if (!res.ok) {
      let reason = '';
      try { const j = await res.json(); reason = j.error?.status || j.error?.errors?.[0]?.reason || ''; } catch { /* 본문 없음 */ }
      throw Object.assign(new Error(`구글 응답 ${res.status}${reason ? ' · ' + reason : ''}`), { code: `${res.status}${reason ? '_' + reason : ''}` });
    }
    return res.status === 204 ? null : res.json();
  }
  const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
  const DRIVE = 'https://www.googleapis.com/drive/v3/files';

  function acceptToken(accessToken, expiresIn, via) {
    token = accessToken;
    tokenExp = Date.now() + (Number(expiresIn) || 3600) * 1000 - 60_000;
    status('stLogin', `로그인됨 (${via}) · 약 ${Math.round((tokenExp - Date.now()) / 60000)}분 동안 유효`, 'ok');
    renderButtons();
    if (session.fileId) refreshSheetInfo().catch(() => {});
  }

  // ---------------------------------------------------------------- 1. 로그인 — 팝업 방식 (Google Identity Services)
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true; s.onload = resolve; s.onerror = () => reject(new Error('스크립트를 불러오지 못했습니다: ' + src));
      document.head.append(s);
    });
  }
  let gisReady = null;
  function ensureGis() {
    gisReady = gisReady || loadScript('https://accounts.google.com/gsi/client').then(() => {
      tokenClient = google.accounts.oauth2.initTokenClient({
        client_id: cfg.clientId,
        scope: SCOPE,
        callback: resp => {
          if (resp.error) { status('stLogin', '로그인 실패: ' + resp.error, 'bad'); setResult('loginPopup', false, resp.error); return; }
          acceptToken(resp.access_token, resp.expires_in, '팝업');
          setResult('loginPopup', true);
        },
        error_callback: err => {
          const code = err?.type || 'unknown';
          const msg = code === 'popup_failed_to_open' ? '팝업 창이 열리지 않았습니다'
            : code === 'popup_closed' ? '로그인 창이 닫혔습니다 (완료 전에 닫혔거나, 설치 앱에서 결과를 돌려받지 못함)'
            : '로그인 중 오류가 났습니다';
          status('stLogin', `${msg} · ${code}`, 'bad');
          setResult('loginPopup', false, code);
        },
      });
    });
    return gisReady;
  }
  // 팝업은 버튼을 누른 그 순간에 열어야 막히지 않음 — 스크립트는 화면이 열릴 때 미리 불러 둠
  $('btnPopup').addEventListener('click', () => {
    if (!tokenClient) { status('stLogin', '구글 로그인 준비 중입니다. 잠시 뒤 다시 눌러 주세요'); ensureGis().catch(e => status('stLogin', e.message, 'bad')); return; }
    status('stLogin', '구글 로그인 창을 여는 중…');
    tokenClient.requestAccessToken({ prompt: '' });
  });

  // ---------------------------------------------------------------- 1. 로그인 — 이동 방식 (현재 창이 구글로 갔다가 돌아옴)
  $('btnRedirect').addEventListener('click', () => {
    const state = crypto.getRandomValues(new Uint32Array(4)).join('-');
    session.state = state;
    saveSession();
    const q = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: REDIRECT_URI,
      response_type: 'token',
      scope: SCOPE,
      include_granted_scopes: 'true',
      state,
    });
    location.assign('https://accounts.google.com/o/oauth2/v2/auth?' + q.toString());
  });
  function consumeRedirect() {
    if (!location.hash || location.hash.length < 2) return;
    const h = new URLSearchParams(location.hash.slice(1));
    // 토큰이 주소창 · 방문 기록에 남지 않도록 바로 지움
    history.replaceState(null, '', location.pathname + location.search);
    if (!h.has('access_token') && !h.has('error')) return;
    const expected = session.state;
    session.state = null;
    saveSession();
    if (h.get('error')) { status('stLogin', '로그인 실패: ' + h.get('error'), 'bad'); setResult('loginRedirect', false, h.get('error')); return; }
    if (!expected || h.get('state') !== expected) { status('stLogin', '로그인 확인값이 맞지 않아 결과를 버렸습니다', 'bad'); setResult('loginRedirect', false, 'state_mismatch'); return; }
    acceptToken(h.get('access_token'), h.get('expires_in'), '이동');
    setResult('loginRedirect', true);
  }

  // ---------------------------------------------------------------- 2. 새 시트 만들기 (정해진 양식 · 공유 없음)
  $('btnCreate').addEventListener('click', async () => {
    status('stSheet', '내 드라이브에 시트를 만드는 중…');
    try {
      const created = await gfetch(SHEETS, {
        method: 'POST',
        body: JSON.stringify({
          properties: { title: '코웍-코인 집행 내역 (시제품)', locale: 'ko_KR', timeZone: 'Asia/Seoul' },
          sheets: [{ properties: { title: SHEET_TITLE, gridProperties: { frozenRowCount: 1 } } }],
        }),
      });
      const id = created.spreadsheetId;
      const sheetId = created.sheets[0].properties.sheetId;
      await gfetch(`${SHEETS}/${id}/values/${encodeURIComponent(SHEET_TITLE + '!A1:H1')}?valueInputOption=RAW`, {
        method: 'PUT', body: JSON.stringify({ values: [HEADER] }),
      });
      // 예산 선택 목록 · 행 ID 칸 숨김 · 머리글 굵게
      await gfetch(`${SHEETS}/${id}:batchUpdate`, {
        method: 'POST',
        body: JSON.stringify({ requests: [
          { setDataValidation: {
            range: { sheetId, startRowIndex: 1, startColumnIndex: 1, endColumnIndex: 2 },
            rule: { condition: { type: 'ONE_OF_LIST', values: BUDGETS.map(v => ({ userEnteredValue: v })) }, strict: true, showCustomUi: true },
          } },
          { updateDimensionProperties: { range: { sheetId, dimension: 'COLUMNS', startIndex: 7, endIndex: 8 }, properties: { hiddenByUser: true }, fields: 'hiddenByUser' } },
          { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
        ] }),
      });
      session.fileId = id;
      saveSession();
      setResult('create', true);
      await refreshSheetInfo();
      status('stSheet', '새 시트를 만들고 연결했습니다', 'ok');
    } catch (e) {
      status('stSheet', '시트를 만들지 못했습니다: ' + e.message, 'bad');
      setResult('create', false, e.code);
    }
    renderButtons();
  });

  // ---------------------------------------------------------------- 2. 기존 시트 — 링크 붙여 넣기 → 구글 파일 선택 창에서 확인
  function fileIdFromLink(text) {
    const s = (text || '').trim();
    const m = s.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/) || s.match(/^([a-zA-Z0-9_-]{25,})$/);
    return m ? m[1] : null;
  }
  function ensurePicker() {
    pickerReady = pickerReady || loadScript('https://apis.google.com/js/api.js')
      .then(() => new Promise((resolve, reject) => gapi.load('picker', { callback: resolve, onerror: () => reject(new Error('구글 파일 선택 창을 불러오지 못했습니다')) })));
    return pickerReady;
  }
  $('btnPick').addEventListener('click', async () => {
    const pasted = fileIdFromLink($('inLink').value);
    if (!pasted) { status('stSheet', '구글 시트 링크를 붙여 넣어 주세요 (docs.google.com/spreadsheets/d/… 형식)', 'bad'); return; }
    status('stSheet', '구글 파일 선택 창을 여는 중…');
    try {
      await ensurePicker();
      const view = new google.picker.DocsView(google.picker.ViewId.SPREADSHEETS).setMode(google.picker.DocsViewMode.LIST);
      if (typeof view.setFileIds === 'function') view.setFileIds(pasted); // 붙여 넣은 시트만 보이게
      const picker = new google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(cfg.apiKey)
        .setAppId(cfg.appId) // 이 값이 있어야 고른 파일에 앱 접근 권한(drive.file)이 붙음
        .setOrigin(location.origin)
        .setLocale('ko')
        .setTitle('붙여 넣은 시트를 골라 주세요')
        .setCallback(async data => {
          const action = data[google.picker.Response.ACTION];
          if (action === google.picker.Action.CANCEL) { status('stSheet', '선택을 취소했습니다'); return; }
          if (action !== google.picker.Action.PICKED) return;
          const picked = data[google.picker.Response.DOCUMENTS][0][google.picker.Document.ID];
          setResult('pick', true);
          if (picked !== pasted) {
            status('stSheet', '고른 시트가 붙여 넣은 링크와 다릅니다. 같은 시트를 골라 주세요', 'bad');
            setResult('match', false, 'different_file');
            return;
          }
          setResult('match', true);
          session.fileId = picked;
          saveSession();
          try { await refreshSheetInfo(); status('stSheet', '기존 시트를 연결했습니다', 'ok'); }
          catch (e) { status('stSheet', '연결은 됐지만 시트 정보를 읽지 못했습니다: ' + e.message, 'bad'); }
          renderButtons();
        })
        .build();
      picker.setVisible(true);
    } catch (e) {
      status('stSheet', e.message, 'bad');
      setResult('pick', false, e.code || 'picker_error');
    }
  });

  async function refreshSheetInfo() {
    const f = await gfetch(`${DRIVE}/${session.fileId}?fields=name,shared,webViewLink`);
    $('sheetInfo').classList.remove('hidden');
    $('siName').textContent = f.name;
    $('siShared').textContent = f.shared ? '다른 사람에게 공유돼 있음 — 공유를 해제해 주세요' : '제한됨 (나만 보기)';
    $('siShared').style.color = f.shared ? 'var(--bad)' : 'var(--accent)';
    $('siLink').href = f.webViewLink;
    setResult('restricted', !f.shared, f.shared ? 'shared' : '');
    renderButtons();
  }

  // ---------------------------------------------------------------- 3. 쓰기 · 읽기
  async function firstSheetTitle() {
    const meta = await gfetch(`${SHEETS}/${session.fileId}?fields=sheets.properties.title`);
    const titles = (meta.sheets || []).map(s => s.properties.title);
    return titles.includes(SHEET_TITLE) ? SHEET_TITLE : titles[0];
  }
  const range = (title, a1) => encodeURIComponent(`'${title.replace(/'/g, "''")}'!${a1}`);

  $('btnAppend').addEventListener('click', async () => {
    status('stData', '가상 행을 추가하는 중…');
    try {
      const title = await firstSheetTitle();
      const d = new Date();
      const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const budget = BUDGETS[Math.floor(Math.random() * BUDGETS.length)];
      const amount = (Math.floor(Math.random() * 9) + 1) * 1000;
      const rowId = 'poc-' + crypto.getRandomValues(new Uint32Array(2)).join('');
      await gfetch(`${SHEETS}/${session.fileId}/values/${range(title, 'A:H')}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`, {
        method: 'POST',
        body: JSON.stringify({ values: [[today, budget, '', '시제품 테스트 품목', amount, '테스트 사용처', '가상 데이터', rowId]] }),
      });
      setResult('append', true);
      status('stData', `가상 행을 추가했습니다 (${budget} · ${amount.toLocaleString('ko-KR')}원)`, 'ok');
    } catch (e) {
      status('stData', '쓰지 못했습니다: ' + e.message, 'bad');
      setResult('append', false, e.code);
    }
  });

  function parseAmount(v) {
    const n = Number(String(v ?? '').replace(/[,\s원₩]/g, ''));
    return Number.isFinite(n) ? n : NaN;
  }
  function monthOf(v) {
    const m = String(v ?? '').trim().match(/^(\d{4})[-./]\s*(\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}` : null;
  }
  $('btnRead').addEventListener('click', async () => {
    status('stData', '시트를 읽는 중…');
    try {
      const title = await firstSheetTitle();
      const res = await gfetch(`${SHEETS}/${session.fileId}/values/${range(title, 'A2:H')}?valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`);
      const rows = res.values || [];
      const groups = new Map();
      let skipped = 0;
      for (const r of rows) {
        const month = monthOf(r[0]);
        const amount = parseAmount(r[4]);
        if (!month || !BUDGETS.includes(r[1]) || !Number.isFinite(amount)) { if (r.some(c => String(c ?? '').trim())) skipped++; continue; }
        const key = `${month}|${r[1]}`;
        const g = groups.get(key) || { month, budget: r[1], count: 0, sum: 0 };
        g.count++; g.sum += amount;
        groups.set(key, g);
      }
      const tbody = $('totals').querySelector('tbody');
      tbody.textContent = '';
      for (const g of [...groups.values()].sort((a, b) => (b.month + b.budget).localeCompare(a.month + a.budget))) {
        const tr = document.createElement('tr');
        for (const [v, cls] of [[g.month], [g.budget], [g.count.toLocaleString('ko-KR'), 'num'], [g.sum.toLocaleString('ko-KR') + '원', 'num']]) {
          const td = document.createElement('td');
          td.textContent = v;
          if (cls) td.className = cls;
          tr.append(td);
        }
        tbody.append(tr);
      }
      $('totals').classList.toggle('hidden', groups.size === 0);
      setResult('read', true);
      status('stData', `${rows.length}행을 읽었습니다${skipped ? ` · 형식이 맞지 않는 ${skipped}행은 합계에서 뺐습니다` : ''}`, 'ok');
    } catch (e) {
      status('stData', '읽지 못했습니다: ' + e.message, 'bad');
      setResult('read', false, e.code);
    }
  });

  // ---------------------------------------------------------------- 4. 결과 복사 · 로그인 해제
  $('btnCopy').addEventListener('click', async () => {
    const lines = [
      '[코웍-코인 시트 시제품 결과]',
      `실행 방식: ${standalone() ? '설치 앱' : '브라우저 탭'}`,
      `기기: ${deviceLabel()}`,
      ...CHECKS.map(([key, label]) => {
        const r = session.results[key];
        return `${!r ? '–' : r.ok ? '✓' : '✗'} ${label}${r && !r.ok && r.code ? ` (${r.code})` : ''}`;
      }),
    ];
    const text = lines.join('\n');
    try { await navigator.clipboard.writeText(text); $('btnCopy').textContent = '복사했습니다'; }
    catch { window.prompt('아래 내용을 복사해 주세요', text); }
    setTimeout(() => { $('btnCopy').textContent = '결과 복사'; }, 2000);
  });
  $('btnRevoke').addEventListener('click', () => {
    const t = token;
    token = null; tokenExp = 0;
    if (t && window.google?.accounts?.oauth2) google.accounts.oauth2.revoke(t, () => {});
    else if (t) fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(t), { method: 'POST' }).catch(() => {});
    status('stLogin', '로그인을 해제했습니다');
    renderButtons();
  });

  // ---------------------------------------------------------------- 시작
  renderEnv();
  renderChecks();
  if (!configured) {
    $('configWarn').classList.remove('hidden');
  } else {
    consumeRedirect();
    ensureGis().catch(e => status('stLogin', e.message, 'bad'));
  }
  if (session.fileId && !token) status('stSheet', '이전에 연결한 시트가 있습니다. 로그인하면 이어서 시험할 수 있습니다');
  renderButtons();
})();

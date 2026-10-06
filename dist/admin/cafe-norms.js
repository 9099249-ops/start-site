(() => {
  'use strict';

  const labels = {
    existing: 'Текущая', confirmed: 'Подтверждено', assumed: 'Предположение', unknown: 'Уточнить'
  };
  let busy = false;
  let section = null;
  let body = null;
  let status = null;
  let search = null;
  let onlyReview = null;
  let rows = [];

  const text = (value, fallback = '') => value === null || value === undefined ? fallback : String(value);
  const cell = (row, value, className = '') => {
    const node = document.createElement('td');
    if (className) node.className = className;
    node.textContent = text(value);
    row.append(node);
    return node;
  };
  const ensureUI = () => {
    if (section?.isConnected) return true;
    section = document.querySelector('#cafe-norms');
    if (!section) return false;
    section.replaceChildren();
    const heading = document.createElement('h2');
    heading.textContent = 'Подготовленные нормы';
    const controls = document.createElement('div');
    controls.className = 'cafe-norms-controls';
    search = document.createElement('input');
    search.type = 'search';
    search.setAttribute('aria-label', 'Поиск по подготовленным нормам');
    search.placeholder = 'Поиск';
    const label = document.createElement('label');
    onlyReview = document.createElement('input');
    onlyReview.type = 'checkbox';
    onlyReview.checked = true;
    label.append(onlyReview, document.createTextNode('Только уточнить'));
    controls.append(search, label);
    status = document.createElement('p');
    status.className = 'cafe-norms-status';
    status.setAttribute('role', 'status');
    const viewport = document.createElement('div');
    viewport.className = 'cafe-norms-viewport';
    const table = document.createElement('table');
    table.className = 'cafe-norms-table';
    const thead = document.createElement('thead');
    const header = document.createElement('tr');
    for (const name of ['Товар и вариант', 'Ингредиент / расходник', 'Единица', 'На порцию', 'Уточнить']) {
      const th = document.createElement('th');
      th.scope = 'col';
      th.textContent = name;
      header.append(th);
    }
    thead.append(header);
    body = document.createElement('tbody');
    table.append(thead, body);
    viewport.append(table);
    section.append(heading, controls, status, viewport);
    search.addEventListener('input', paint);
    onlyReview.addEventListener('change', paint);
    return true;
  };
  const basisQuantity = row => {
    if (row.quantity === null || row.quantity === undefined || row.quantity === '') return '';
    if (row.basis === 'order') return `${row.quantity} на заказ`;
    if (row.basis === 'shift') return `${row.quantity} за смену`;
    return row.quantity;
  };
  const paint = () => {
    if (!ensureUI()) return;
    body.replaceChildren();
    const query = search.value.trim().toLocaleLowerCase('ru');
    const visible = rows.filter(row => {
      if (onlyReview.checked && row.status === 'existing' && !row.reason) return false;
      return !query || [row.itemName, row.variantName, row.stockName, row.component, row.reason, row.unit]
        .some(value => text(value).toLocaleLowerCase('ru').includes(query));
    });
    for (const data of visible) {
      const tr = document.createElement('tr');
      tr.dataset.id = text(data.id);
      tr.dataset.itemId = text(data.itemId);
      tr.dataset.component = text(data.component);
      const menuName = [data.itemName, data.variantName].filter(Boolean).join(' · ');
      const menu = cell(tr, menuName);
      menu.className = 'cafe-norms-menu';
      if (menuName) menu.title = menuName;
      const ingredient = cell(tr, data.stockName || data.component);
      ingredient.title = text(data.stockName || data.component);
      const unit = cell(tr, data.unit, 'cafe-norms-unit');
      if (data.unit) unit.title = text(data.unit);
      cell(tr, basisQuantity(data), 'cafe-norms-number');
      const review = document.createElement('td');
      review.className = 'cafe-norms-review';
      const source = document.createElement('small');
      source.textContent = labels[data.source] || labels.unknown;
      review.append(source);
      if (data.reason) {
        const reason = document.createElement('span');
        reason.textContent = text(data.reason);
        review.append(reason);
      }
      if (data.status === 'needs_stock' && data.stockItemId !== null && data.stockItemId !== undefined) {
        const stockLink = document.createElement('a');
        stockLink.href = '/admin/purchase/';
        stockLink.textContent = 'Проверить остаток';
        review.append(stockLink);
      }
      if (data.basis === 'portion' && data.itemId !== null && data.itemId !== undefined) {
        const edit = document.createElement('button');
        edit.type = 'button';
        edit.textContent = 'Править расход';
        edit.addEventListener('click', () => section.dispatchEvent(new CustomEvent('cafe-norm-edit', {
          detail: { itemId: data.itemId, component: data.component }
        })));
        review.append(edit);
      }
      tr.append(review);
      body.append(tr);
    }
  };
  const render = stockConfig => {
    if (!ensureUI()) return;
    const plan = stockConfig?.consumablesPlan;
    section.hidden = !plan || !Array.isArray(plan.rows);
    rows = section.hidden ? [] : plan.rows;
    status.textContent = '';
    paint();
  };
  const refresh = async () => {
    if (busy) return;
    if (!ensureUI()) return;
    busy = true;
    status.textContent = 'Обновление…';
    try {
      const response = await fetch('/api/admin/cafe/stock', { method: 'GET', cache: 'no-store' });
      let data;
      try { data = await response.json(); } catch { data = {}; }
      if (!response.ok) throw new Error(data.error || 'Не удалось обновить подготовленные нормы.');
      render(data);
      status.textContent = '';
      delete status.dataset.kind;
    } catch (error) {
      status.textContent = error.message || 'Не удалось обновить подготовленные нормы.';
      status.dataset.kind = 'error';
    } finally {
      busy = false;
    }
  };

  window.STARTCafeNorms = { render, refresh };
})();

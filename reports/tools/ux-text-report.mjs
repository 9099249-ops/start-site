import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baselinePath = path.join(root, 'reports/evidence/browser-baseline.json');
const outputDir = path.join(root, 'reports');
const evidenceDir = path.join(outputDir, 'evidence');
const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));

const isMobile = (screen) => /mobile/i.test(screen.name) || screen.viewport?.width < 600;
const measured = baseline.screens.filter((screen) => Boolean(screen.countMethod));
const excludedMobile = measured.filter(isMobile);
const selected = measured.filter((screen) => !isMobile(screen));
const siteConfigLabels = new Set([
  'Содержимое сайта и SEO', 'Фотографии', 'Контакты и часы работы', 'Тарифы САПа',
  'SEO и ссылки в соцсетях', 'SEO: страницы услуг', 'Доступ сотрудника',
  'Управление станцией', 'СМС и уведомления', 'Включить платную отправку СМС',
  'СМС с промокодом', 'Имя отправителя SMS Aero', 'Сохранить настройки СМС',
  'Журнал СМС (последние 100)',
]);
const paymentLegend = 'Зелёный — оплачено · Жёлтый — ожидание · Красный — нужна сверка / отменён';

function contentType(screenName, text, tags) {
  const value = text.replace(/\s+/g, ' ').trim();
  if (screenName === 'loaded-rental' && value === 'Вернулся') return 'Надпись интерфейса: действие';
  if (/^Тестовый гость \d+/.test(value) || /^№\d+/.test(value) ||
      /\bТестовый гость \d+\b/.test(value) || /^\d{1,2}:\d{2}$/.test(value) ||
      /^\d{1,2} (?:мин|ч)/.test(value) || /^\+?\d+ мин$/.test(value) ||
      /^\d[\d ]*(?:,\d{2})? ₽$/.test(value) || /^\d+×/.test(value)) return 'Динамические бизнес-данные';
  if (screenName === 'cafe-new' && (tags.some((tag) => ['H2', 'H3', 'STRONG', 'SMALL'].includes(tag)) ||
      /^(?:\d+ г|\d+ мл|\d+ ₽|\d+ порц\.)/.test(value))) return 'Каталог: товар, цена или порция';
  if (/^(?:В работе|Ожидает оплаты|Готов к выдаче|Выполнен|Вернулся|Просрочка|На воде|Оплачено|Отменён|Нужна сверка)$/.test(value) ||
      /(?:не открыт|не сформирован|ожидает|просрок|сверк|отменён|готов к выдаче|выполнен)/i.test(value)) return 'Операционный статус';
  if (/^(?:\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?|пн|вт|ср|чт|пт|сб|вс)[,. ]/i.test(value) ||
      /^\d{1,2}:\d{2}$/.test(value) || /\b\d[\d ]*(?:,\d{2})? ₽\b/.test(value)) return 'Операционное значение';
  if (screenName === 'loaded-rental' && /^(?:САП|ЭлектроСАП|Каяк|Вёсельная лодка|ВелоСАП)/.test(value)) return 'Данные проката: вид техники';
  if (screenName === 'cafe-new' && tags.includes('A')) return 'Категория или позиция меню';
  if (/^\d+$/.test(value) && ['B', 'SPAN', 'STRONG', 'SMALL'].some((tag) => tags.includes(tag))) return 'Динамический счётчик';
  if (['loaded-rental', 'loaded-cafe-desktop'].includes(screenName) &&
      ['SPAN', 'DIV', 'B', 'STRONG', 'SMALL', 'P'].some((tag) => tags.includes(tag))) return 'Значение строки проката или заказа';
  if (tags.some((tag) => ['H1', 'H2', 'H3', 'BUTTON', 'A', 'SUMMARY', 'LABEL'].includes(tag))) return 'Надпись интерфейса';
  if (tags.some((tag) => ['P', 'SMALL'].includes(tag))) return 'Справочный текст';
  if (tags.some((tag) => ['SPAN', 'DIV', 'B', 'STRONG', 'SMALL', 'TIME'].includes(tag))) return 'Текстовая подпись или значение';
  return 'Текст без отдельного UI-контрола';
}

function review(screenName, text, tags, occurrences) {
  const value = text.replace(/\s+/g, ' ').trim();
  if (screenName === 'loaded-rental' && value === 'Вернулся') {
    return { needed: 'Да, действие возврата', action: 'Сократить', proposal: 'Вернуть', targetText: 'Вернуть', scope: 'Только кнопки возврата оборудования, не сохранённые статусы', affected: occurrences,
      reason: 'Снимок loaded-rental.txt подтверждает, что это кнопка, выполняющая возврат, а не уже наступивший статус. Повелительная форма яснее; доплату и состояние оплаты рядом с действием сохранить.' };
  }
  if (screenName === 'loaded-cafe-desktop' && value === 'Поиск и фильтры') {
    return { needed: 'Да', action: 'Сократить при условии', proposal: 'Только после постоянного переноса поля поиска из сворачиваемого блока в видимую область списка: переименовать блок в «Фильтры». До переноса поиска оставить «Поиск и фильтры».', targetText: 'Фильтры', scope: 'Экран; применять только после изменения расположения поиска', affected: occurrences,
      reason: 'Сейчас поиск находится внутри сворачиваемого блока. Короткая подпись «Фильтры» скроет факт наличия поиска и ухудшит его обнаружение. Сокращение безопасно только если поиск заранее и постоянно вынесен над списком; без этого изменения текущую подпись сохранять.' };
  }
  if (screenName === 'guest-bills' && value === 'Счета гостей' && tags.includes('H2')) {
    return { needed: 'Да, заголовок раздела остаётся во вкладке', action: 'Убрать с экрана', proposal: 'Убрать только повторный H2; оставить вкладку «Счета гостей» и остальные точки входа.', scope: 'Экран; надпись и функция сохраняются в системе', affected: 1,
      reason: 'На экране уже есть вкладка с тем же названием. Удаляется только один заголовок H2 из трёх наблюдённых узлов; навигация и доступ к счетам сохраняются.' };
  }
  if (screenName === 'loaded-cafe-desktop' && value === paymentLegend) {
    return { needed: 'Да, объяснение доступно по запросу', action: 'Перенести с экрана', proposal: 'Показывать легенду по запросу; у заказа со сверкой всегда оставить текстовое предупреждение «Нужна сверка».', scope: 'Экран списка; справка сохраняется в системе', affected: occurrences,
      reason: 'Постоянная легенда занимает место во всём списке. Перенос допустим только если статусы подписаны словами, а предупреждение о сверке показано рядом с затронутым заказом; цвет не должен быть единственным сигналом.' };
  }
  if (screenName === 'home-more' && siteConfigLabels.has(value)) {
    return { needed: 'Да, в настройках', action: 'Перенести с экрана', proposal: 'Оставить доступ в «Настройки» → соответствующий раздел; убрать этот пункт/контрол из «Ещё».', scope: 'Экран «Ещё»; настройка сохраняется в системе', affected: occurrences,
      reason: 'SEO, редактор сайта, платные SMS и редкие административные настройки не относятся к ежедневным операциям. Рекомендация аудита: отделить их от кассы и зарплаты, сохранив доступ и поведение.' };
  }
  const type = contentType(screenName, text, tags);
  if (type === 'Динамические бизнес-данные' || type.startsWith('Каталог:') || type.startsWith('Данные проката:') || type.startsWith('Операцион')) {
    return { needed: 'Да', action: 'Оставить', proposal: text,
      reason: 'Это значение, статус или бизнес-данные тестового снимка; оно нужно для работы и не считается текстовым шумом.' };
  }
  return { needed: 'Да', action: 'Оставить', proposal: text,
    reason: 'Это самостоятельная надпись или справка интерфейса. Без подтверждённого дублирования или понятного контекста сокращение может ухудшить понимание, поэтому сохраняем.' };
}

const rows = [];
for (const screen of selected) {
  const grouped = new Map();
  for (const node of screen.texts ?? []) {
    const text = String(node.text ?? '');
    if (!text.trim()) continue;
    const record = grouped.get(text) ?? { count: 0, tags: new Set() };
    record.count += 1;
    if (node.tag) record.tags.add(node.tag);
    grouped.set(text, record);
  }
  for (const [text, evidence] of grouped) {
    const tags = [...evidence.tags].sort();
    const decision = review(screen.name, text, tags, evidence.count);
    rows.push({ screen: screen.name, currentText: text, type: contentType(screen.name, text, tags),
      needed: decision.needed, action: decision.action, proposal: decision.proposal, reason: decision.reason,
      targetText: decision.targetText, scope: decision.scope ?? 'Без изменения', occurrences: evidence.count, affectedOccurrences: decision.affected,
      sourceTags: tags.join('|') });
  }
}

const codepoints = (text) => [...text].length;
const wordCount = (text) => (text.match(/[\p{L}\p{N}]+(?:[’'-][\p{L}\p{N}]+)*/gu) ?? []).length;
const totals = rows.reduce((acc, row) => {
  acc.occurrences += row.occurrences;
  acc.currentTextCharacters += codepoints(row.currentText) * row.occurrences;
  acc.actions[row.action] = (acc.actions[row.action] ?? 0) + 1;
  acc.byType[row.type] = (acc.byType[row.type] ?? 0) + 1;
  acc.occurrencesByAction[row.action] = (acc.occurrencesByAction[row.action] ?? 0) + (row.affectedOccurrences ?? 0);
  return acc;
}, { occurrences: 0, currentTextCharacters: 0, actions: {}, byType: {}, occurrencesByAction: {} });

const reduction = rows.reduce((acc, row) => {
  if (!row.affectedOccurrences) return acc;
  let chars = 0;
  let words = 0;
  if (row.action.startsWith('Сократить')) {
    const target = row.targetText ?? row.proposal;
    chars = Math.max(0, codepoints(row.currentText) - codepoints(target));
    words = Math.max(0, wordCount(row.currentText) - wordCount(target));
  } else if (row.action === 'Убрать с экрана' || row.action === 'Перенести с экрана') {
    chars = codepoints(row.currentText);
    words = wordCount(row.currentText);
  }
  const weightedChars = chars * row.affectedOccurrences;
  const weightedWords = words * row.affectedOccurrences;
  acc.screenCharacters += weightedChars;
  acc.screenWords += weightedWords;
  acc.byAction[row.action] = (acc.byAction[row.action] ?? 0) + weightedChars;
  if (row.action.startsWith('Сократить')) acc.shortenWords += weightedWords;
  return acc;
}, { screenCharacters: 0, screenWords: 0, shortenWords: 0, byAction: {} });
reduction.screenPercent = Number((100 * reduction.screenCharacters / totals.currentTextCharacters).toFixed(2));

const quote = (value) => {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};
const columns = ['Экран', 'Текущий текст', 'Тип содержания', 'Нужно?', 'Действие', 'Предложение', 'Обоснование', 'Область изменения', 'Повторы', 'Изменяемые повторы', 'Теги источника'];
const csv = [columns, ...rows.map((row) => [row.screen, row.currentText, row.type, row.needed, row.action,
  row.proposal, row.reason, row.scope, row.occurrences, row.affectedOccurrences ?? 0, row.sourceTags])]
  .map((line) => line.map(quote).join(',')).join('\r\n') + '\r\n';

const summary = {
  title: 'Аудит текста интерфейса',
  source: 'reports/evidence/browser-baseline.json',
  scope: {
    measuredStatesWithCountMethod: measured.length,
    includedDesktopStates: selected.map(({ name }) => name),
    excludedMobileDuplicates: excludedMobile.map(({ name }) => name),
    uniqueScreenTextRows: rows.length,
    renderedTextNodeOccurrences: totals.occurrences,
    currentTextCharacters: totals.currentTextCharacters,
    characterUnit: 'Unicode code points, including spaces and punctuation, weighted by rendered text-node occurrences.',
    captureMethod: 'Видимые текстовые узлы всего прокручиваемого документа; закрытые сворачиваемые блоки и варианты списков исключены; текст под модальным фоном может присутствовать.',
    limitation: '12 измеренных состояний компьютера, не полный перечень экранов и ошибок. Тестовые имена, цены, заказы, статусы и каталог показаны как бизнес-данные, а не как шум.',
  },
  classification: { uniqueRowsByType: totals.byType },
  review: {
    uniqueRowsByAction: totals.actions,
    affectedOccurrencesByAction: totals.occurrencesByAction,
    screenReduction: {
      weightedCharacters: reduction.screenCharacters,
      weightedWords: reduction.screenWords,
      percentOfCurrentObservedCharacters: reduction.screenPercent,
      byActionCharacters: reduction.byAction,
      removedFromSystemCharacters: 0,
      note: 'Это потенциальное сокращение постоянного текста выбранных экранов при выполнении всех условий в рекомендациях. Из общего объёма 8 знаков относятся к переименованию фильтра только после постоянного выноса поиска; перенос легенды также требует сохранения текстовых статусов и предупреждений. Перенесённая справка и функция остаются доступны в системе.',
    },
    safeguards: [
      'Не менять цены, статусы, сроки, имена, клиентские сведения, комментарии и предупреждения.',
      'Не сокращать «Единиц техники»: 41 единица техники не равна 40 договорам аренды.',
      'Легенду переносить только при наличии текстовых статусов и предупреждения о сверке рядом с заказом; цвет сам по себе недостаточен.',
      '«Поиск и фильтры» переименовывать в «Фильтры» только после постоянного переноса поиска из сворачиваемого блока; до этого текущую подпись сохранить.',
      'Поиск, кассовые команды, зарплату и бизнес-функции сохранять. Не удалять текст или поведение из системы.',
      'Частота использования свободной цены и бесплатной выдачи не измерялась, поэтому эти действия оставлены.',
      'Одинаковый текст группируется только внутри одного экрана; число узлов и число затрагиваемых узлов указаны отдельно.',
    ],
    recommendations: rows.filter((row) => row.action !== 'Оставить').map(({ screen, currentText, action, proposal, targetText, scope, occurrences, affectedOccurrences, reason }) =>
      ({ screen, currentText, action, proposal, ...(targetText ? { targetText } : {}), scope, occurrences, affectedOccurrences, reason })),
  },
};

const mdRows = rows.map((row) => [row.screen, row.currentText, row.type, row.needed, row.action, row.proposal,
  row.reason, row.scope, row.occurrences, row.affectedOccurrences ?? 0].map((value) =>
  String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')));
const table = [
  '| Экран | Текущий текст | Тип содержания | Нужно? | Действие | Предложение | Обоснование | Область изменения | Повторы | Изменяемые повторы |',
  '|---|---|---|---|---|---|---|---|---:|---:|',
  ...mdRows.map((cells) => `| ${cells.join(' | ')} |`),
].join('\n');
const recommendations = rows.filter((row) => row.action !== 'Оставить')
  .map((row) => `- **${row.screen}: «${row.currentText}» → ${row.action.toLowerCase()}.** ${row.proposal} ${row.reason} ${row.action.startsWith('Сократить') ? `Условное сокращение после выполнения условия: ${codepoints(row.currentText) - codepoints(row.targetText ?? row.proposal)} знаков × ${row.affectedOccurrences}.` : `Сокращение на экране: ${codepoints(row.currentText)} знаков × ${row.affectedOccurrences}.`}`)
  .join('\n');
const markdown = `# Аудит текста интерфейса\n\n` +
  `## Объём\n\n` +
  `Взяты ${selected.length} состояния компьютера с указанным методом подсчёта из reports/evidence/browser-baseline.json. Это видимые текстовые узлы всей прокручиваемой страницы, не только первого экрана. Закрытые сворачиваемые блоки и варианты списков исключены; подложка модального окна может попасть в снимок. Исключены мобильные дубли: ${excludedMobile.map(({ name }) => name).join(', ')}. Это выборка, а не полный перечень экранов и ошибок.\n\n` +
  `- Уникальных пар «экран + текст»: ${rows.length}; наблюдённых текстовых узлов: ${totals.occurrences}.\n- Текущий объём: ${totals.currentTextCharacters} знаков с пробелами, взвешенных по числу узлов.\n- Потенциальное сокращение постоянного текста выбранных экранов: ${reduction.screenCharacters} знаков (${reduction.screenPercent}% от измеренного объёма), ${reduction.screenWords} слов, при соблюдении всех условий таблицы. Из них ${reduction.byAction['Сократить при условии'] ?? 0} знаков только после выноса поиска; перенос легенды требует сохранения текстовых статусов и предупреждений. Удаление из системы: 0 знаков.\n\n` +
  `## Выводы\n\n` +
  `Ключевое различие в прокате: 40 аренд и 41 единица техники. Поэтому «Единиц техники» оставлено без изменения. Тестовые имена гостей, заказы, цены, сроки, статусы и названия каталога помечены как бизнес-данные, а не текстовый шум. Подпись «Поиск и фильтры» сокращается до «Фильтры» только после постоянного переноса поиска из сворачиваемого блока; пока поиск остаётся внутри, текущую подпись нужно сохранить.\n\n` +
  `Предлагаемые изменения опираются на точные наблюдаемые строки и тематические рекомендации:\n\n${recommendations}\n\n` +
  `Свободную цену и бесплатную выдачу не предлагается прятать: их реальная частота не измерялась. SEO, редактор сайта и платные СМС предлагается перенести из «Ещё» в соответствующие настройки; доступ и поведение сохраняются. Предупреждения, включая сверку оплаты, не удаляются.\n\n` +
  `## Подсчёт сокращения\n\n` +
  `Для каждой изменяемой строки считаются точные знаки текущего и предложенного текста, умноженные на число затрагиваемых узлов. При переносе учтено только исчезновение с выбранного экрана; текст остаётся доступен в системе. При удалении учтён только конкретный узел, не все одинаковые подписи. Знаковый знаменатель включает каждый непустой текстовый узел выборки с повторами.\n\n` +
  `## Полная таблица\n\n${table}\n`;

fs.mkdirSync(evidenceDir, { recursive: true });
fs.writeFileSync(path.join(outputDir, 'ux-text-audit.csv'), csv, 'utf8');
fs.writeFileSync(path.join(outputDir, 'ux-text-audit.md'), markdown, 'utf8');
fs.writeFileSync(path.join(evidenceDir, 'text-audit-summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ states: selected.length, rows: rows.length, occurrences: totals.occurrences,
  characters: totals.currentTextCharacters, actions: totals.actions, reduction, excludedMobile: excludedMobile.map(({ name }) => name) }, null, 2));

/* ---------- 1. 取数据：async/await 写法 ---------- */

/**
 * 用 async/await 读取 JSON。
 * 相比 .then 链，这里能用 try/catch 一次性兜住「网络错 / 404 / JSON 语法错」。
 * @param {string} url 数据地址
 * @returns {Promise<object>} 解析后的 JSON 对象
 */
async function loadData(url) {
  const res = await fetch(url);                       // 请求；不写 .then
  if (!res.ok) throw new Error(`HTTP ${res.status}`); // fetch 不会因 404 抛错，必须自己判
  return res.json();                                  // 解析 JSON 也返回 Promise，直接 return
}

/* ---------- 2. 文本 ---------- */

/** 把模板里的 {xxx} 换成实际数值；没提供的占位符原样保留，方便排查 */
const fill = (tpl, vars) => tpl.replace(/\{(\w+)\}/g, (m, key) => (vars[key] ?? m));

/* ---------- 3. DOM 小工具 ---------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/**
 * 建节点：make('div', 'frame-head', '文字')。
 * 文字走 textContent，代码里的 < 号不会被当成标签。
 * @returns {HTMLElement}
 */
function make(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== '') node.textContent = text;
  return node;
}

/* ---------- 4. 代码面板（d1 步进 / d2 判定共用） ---------- */

/**
 * 代码区组件：一次绑定容器，之后调 render 铺代码、调 paint 移动高亮。
 * 开题说明里两个难点都有「左侧代码区：当前执行行高亮」，所以这部分是共用的；
 * 但 d1 额外要在行内圈出「即将执行的调用」，那是 d1 自己的装饰，写在 d1.js。
 *
 * @param {HTMLElement} root 代码容器（<ol id="code">）
 */
function createCodePanel(root) {
  /**
   * 渲染代码：一行一个 li，行号交给 CSS 计数器。
   * 每行内部再包一个 .code-body，页面可按需在行内插入标记，
   * 而不会破坏 li 的 flex 布局（行号与正文各占一个 flex 项）。
   */
  function render(lines) {
    root.replaceChildren(); // 先清空，保证页面里没有手写的代码残留
    lines.forEach((text) => {
      const li = make('li');
      li.dataset.text = text;                        // 留一份纯文本，重新拼装行内标记时用
      li.append(make('span', 'code-body', text));
      root.append(li);
    });
  }

  /**
   * 移动当前行高亮，并清掉上一页可能留下的行内标记。
   * @param {number} line 当前行号（1 基）
   * @returns {HTMLElement|null} 当前行元素，页面可在此基础上叠加自己的标记
   */
  function paint(line) {
    const items = Array.from(root.children);
    items.forEach((li, i) => {
      li.classList.toggle('active', i + 1 === line);
      li.firstElementChild.textContent = li.dataset.text; // 复位成纯文本
    });
    return items[line - 1] || null;
  }

  return { render, paint };
}

/* ---------- 5. 参数区（d1 输入框 / d2 输入框 + 开关 / d3 滑块） ---------- */

/**
 * 渲染数值型参数：名称、范围、默认值、说明，全部来自 JSON。
 * input 可以是 number 输入框，也可以是 range 滑块，min/max/value 两边通用。
 *
 * @param {{label: HTMLElement, input: HTMLElement, hint: HTMLElement}} nodes 落点
 * @param {{label: string, min: number, max: number, default: number, hint: string}} param
 */
function renderParam(nodes, param) {
  nodes.label.textContent = param.label;
  nodes.input.min = param.min;
  nodes.input.max = param.max;
  nodes.input.value = param.default;
  nodes.hint.textContent = param.hint;
}

/* ---------- 6. 步进播放器（d1 步进推演 / d2 操作判定） ---------- */

/**
 * 步进播放器：只管「第几步 + 定时器」，画面怎么画交给 onStep。
 * 开题说明把「播放控件」列为三页可复用的部分，所以状态机放这里；
 * d3 是参数探索型（拖滑块），不需要它。
 *
 * @param {object}   opts
 * @param {number}   [opts.total]       步骤总数，之后可用 load() 换
 * @param {number}   [opts.interval]    播放时每步停留毫秒（只影响节奏，不影响结果）
 * @param {Function} [opts.onStep]      (index, total) => void，每换一步调用
 * @param {Function} [opts.onPlayState] (playing) => void，播放状态变化时调用
 */
function createPlayer({ total = 0, interval = 800, onStep, onPlayState } = {}) {
  let index = 0;
  let timer = null;

  const emit = () => {
    onStep?.(index, total);
    onPlayState?.(timer !== null);
  };

  const player = {
    get index() { return index; },
    get total() { return total; },

    /** 换一批步骤：停播、回到第 1 步 */
    load(n) {
      clearInterval(timer);
      timer = null;
      total = n;
      index = 0;
      emit();
      return player;
    },

    /** 跳到第 i 步，越界自动夹到首尾 */
    goTo(i) {
      index = Math.max(0, Math.min(i, total - 1));
      emit();
    },

    next() { player.goTo(index + 1); },
    prev() { player.goTo(index - 1); },

    pause() {
      clearInterval(timer);
      timer = null;
      emit();
    },

    /** 播放：到最后一步自动停；已在末尾则从头放 */
    play() {
      if (total < 2) return;
      if (index >= total - 1) player.goTo(0);
      clearInterval(timer);
      timer = setInterval(() => {
        if (index >= total - 1) return player.pause();
        player.goTo(index + 1);
      }, interval);
      emit();
    },

    toggle() { timer ? player.pause() : player.play(); },
  };

  return player;
}

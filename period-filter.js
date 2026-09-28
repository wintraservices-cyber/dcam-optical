// Shared "Period" date-range filter -- a single dropdown (Today,
// Yesterday, Last 7 days, This month, Last month, All, Custom...) used
// the same way on the Orders, Expenses, and Reports pages instead of
// each page having its own bare From/To date inputs. Picking a preset
// computes the from/to dates locally (no server round trip); picking
// "Custom..." reveals the From/To date inputs for a specific range;
// picking "All" means no filter at all (both dates omitted).
//
// Usage:
//   const filter = PeriodFilter.mount(document.getElementById('periodFilterMount'), {
//     onChange: () => loadSomething(),
//   });
//   const { from, to } = filter.getRange(); // both null for "All"
//
// Markup and styling are self-contained (injected once) so any page can
// drop in a mount point and call PeriodFilter.mount() without also
// wiring up its own CSS.
(function (global) {
  let stylesInjected = false;
  function injectStyles() {
    if (stylesInjected) return;
    stylesInjected = true;
    const style = document.createElement('style');
    style.textContent = `
      .period-filter { display: flex; align-items: end; gap: 10px; flex-wrap: wrap; }
      .period-filter .field label {
        display: block;
        font-size: 0.7rem;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--charcoal-soft, #4A4547);
        margin-bottom: 4px;
        font-family: var(--display, inherit);
        font-weight: 700;
      }
      .period-filter select, .period-filter input[type="date"] {
        border: 1.5px solid var(--line, rgba(56,51,52,0.14));
        background: #fff;
        padding: 10px 12px;
        border-radius: 8px;
        font-family: var(--body, inherit);
        font-size: 0.9rem;
        color: var(--charcoal, #383334);
        outline: none;
      }
      .period-filter select:focus, .period-filter input[type="date"]:focus { border-color: var(--blue, #5BAFC0); }
      .period-filter select { min-width: 160px; }
      .period-filter .custom-range { display: none; gap: 10px; align-items: end; flex-wrap: wrap; }
      .period-filter .custom-range.visible { display: flex; }
    `;
    document.head.appendChild(style);
  }

  function toIso(d) {
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function computeRange(preset) {
    const today = new Date();
    const start = (offsetDays) => {
      const d = new Date(today);
      d.setDate(d.getDate() - offsetDays);
      return toIso(d);
    };

    switch (preset) {
      case 'today': {
        const iso = toIso(today);
        return { from: iso, to: iso };
      }
      case 'yesterday': {
        const iso = start(1);
        return { from: iso, to: iso };
      }
      case 'last7': {
        return { from: start(6), to: toIso(today) };
      }
      case 'this_month': {
        const first = new Date(today.getFullYear(), today.getMonth(), 1);
        return { from: toIso(first), to: toIso(today) };
      }
      case 'last_month': {
        const firstOfThis = new Date(today.getFullYear(), today.getMonth(), 1);
        const lastOfPrev = new Date(firstOfThis);
        lastOfPrev.setDate(lastOfPrev.getDate() - 1);
        const firstOfPrev = new Date(lastOfPrev.getFullYear(), lastOfPrev.getMonth(), 1);
        return { from: toIso(firstOfPrev), to: toIso(lastOfPrev) };
      }
      case 'all':
        return { from: null, to: null };
      default:
        return { from: null, to: null };
    }
  }

  function mount(container, opts) {
    opts = opts || {};
    const defaultPreset = opts.defaultPreset || 'last7';
    injectStyles();

    container.innerHTML = `
      <div class="period-filter">
        <div class="field">
          <label>Period</label>
          <select class="period-select">
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="last7">Last 7 days</option>
            <option value="this_month">This month</option>
            <option value="last_month">Last month</option>
            <option value="all">All</option>
            <option value="custom">Custom...</option>
          </select>
        </div>
        <div class="custom-range">
          <div class="field">
            <label>From</label>
            <input type="date" class="custom-from">
          </div>
          <div class="field">
            <label>To</label>
            <input type="date" class="custom-to">
          </div>
        </div>
      </div>
    `;

    const selectEl = container.querySelector('.period-select');
    const customRangeEl = container.querySelector('.custom-range');
    const customFromEl = container.querySelector('.custom-from');
    const customToEl = container.querySelector('.custom-to');

    selectEl.value = defaultPreset;
    customRangeEl.classList.toggle('visible', defaultPreset === 'custom');

    function currentRange() {
      if (selectEl.value === 'custom') {
        return { from: customFromEl.value || null, to: customToEl.value || null };
      }
      return computeRange(selectEl.value);
    }

    function fireChange() {
      if (typeof opts.onChange === 'function') opts.onChange(currentRange());
    }

    selectEl.addEventListener('change', () => {
      const isCustom = selectEl.value === 'custom';
      customRangeEl.classList.toggle('visible', isCustom);
      // Custom starts empty rather than pre-filled -- let the person
      // pick both ends deliberately rather than firing a change on a
      // stale/default range they haven't actually chosen yet.
      if (!isCustom || (customFromEl.value || customToEl.value)) {
        fireChange();
      }
    });
    customFromEl.addEventListener('change', fireChange);
    customToEl.addEventListener('change', fireChange);

    return {
      getRange: currentRange,
      // Lets a page reset back to a known preset (e.g. a "Clear" button
      // elsewhere on the page) without re-mounting the whole control.
      setPreset(preset) {
        selectEl.value = preset;
        customRangeEl.classList.toggle('visible', preset === 'custom');
        fireChange();
      },
    };
  }

  global.PeriodFilter = { mount: mount };
})(window);

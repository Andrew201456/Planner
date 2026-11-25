function startPlanner() {
  "use strict";

  const $ = id => document.getElementById(id);
  const main = $("content");
  const noteDialog = $("note-dialog");
  const bookDialog = $("book-dialog");
  const noteForm = $("note-form");
  const bookForm = $("book-form");
  const prefix = "planner.v1.";
  const colors = {
    butter: "Κίτρινο", sage: "Πράσινο", lilac: "Λιλά",
    apricot: "Βερίκοκο", sky: "Γαλάζιο", rose: "Ροζ"
  };
  const presets = [
    { id: "shopping", name: "Ψώνια", color: "butter", icon: "shopping" },
    { id: "village", name: "Χωριό", color: "sage", icon: "village" },
    { id: "personal", name: "Προσωπικά", color: "lilac", icon: "personal" },
    { id: "ideas", name: "Ιδέες", color: "apricot", icon: "ideas" }
  ];
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const html = value => String(value ?? "").replace(/[&<>"']/g, ch => entities[ch]);
  const icon = (name, css = "") => `<svg class="${css}" aria-hidden="true"><use href="./icons.svg#${name}"/></svg>`;
  const keyFor = (type, id) => prefix + type + "." + id;
  const makeId = () => crypto.randomUUID();
  const validId = id => typeof id === "string" && /^[a-zA-Z0-9-]{1,70}$/.test(id);

  const calFormat = options => new Intl.DateTimeFormat("el-GR", options);
  const monthFmt = calFormat({ month: "long", year: "numeric" });
  const dayFmt = calFormat({ weekday: "long", day: "numeric", month: "long" });
  const shortFmt = calFormat({ day: "numeric", month: "short", year: "numeric" });
  const headerFmt = calFormat({ weekday: "short", day: "numeric", month: "short" });
  const localKey = d => [String(d.getFullYear()).padStart(4, "0"), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  const parseDay = iso => new Date(iso + "T12:00:00");
  const validDay = iso => typeof iso === "string" && /^\d{4}-\d\d-\d\d$/.test(iso) && !iso.startsWith("0000") && localKey(parseDay(iso)) === iso;

  let books = [...presets];
  let notes = [];
  let rawNotes = new Map();
  let storageMessage = "";
  let route = { view: "notes" };
  let selectedDay = localKey(new Date());
  let editing = null;
  let kindChosen = false;
  let toastTimer;

  function isNote(n) {
    return n && validId(n.id) && validId(n.bookId) && typeof n.title === "string" &&
      typeof n.text === "string" && ["text", "list"].includes(n.kind) &&
      Array.isArray(n.items) && n.items.every(i => i && typeof i.label === "string" && typeof i.done === "boolean") &&
      (n.date === "" || validDay(n.date)) && Number.isFinite(n.updated);
  }

  function loadData() {
    const custom = [], loaded = [], raw = new Map();
    try {
      const storage = window.localStorage;
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i);
        if (!key?.startsWith(prefix)) continue;
        const value = storage.getItem(key);
        let item;
        try { item = JSON.parse(value); } catch { continue; }
        if (!item || !validId(item.id)) continue;
        if (key === keyFor("note", item.id) && isNote(item)) {
          loaded.push(item);
          raw.set(item.id, value);
        } else if (key === keyFor("book", item.id) && typeof item.name === "string" && Object.hasOwn(colors, item.color)) {
          custom.push({ id: item.id, name: item.name, color: item.color, icon: "pages", created: item.created || 0 });
        }
      }
      custom.sort((a, b) => a.created - b.created || a.name.localeCompare(b.name, "el"));
      books = [...presets, ...custom];
      notes = loaded.sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
      rawNotes = raw;
      storageMessage = "";
    } catch {
      storageMessage = "Η αποθήκευση στη συσκευή δεν είναι διαθέσιμη σε αυτό το παράθυρο.";
    }
  }

  function write(type, id, record, expected) {
    const key = keyFor(type, id);
    let storage, previous;
    try {
      storage = window.localStorage;
      previous = storage.getItem(key);
    } catch {
      throw new Error("Ο browser δεν επέτρεψε την αποθήκευση στη συσκευή.");
    }
    if (previous !== expected) {
      throw new Error("Η καταχώρηση άλλαξε σε άλλη καρτέλα. Άνοιξέ την ξανά για να δεις την πιο πρόσφατη έκδοση.");
    }
    try {
      if (record === null) storage.removeItem(key);
      else storage.setItem(key, JSON.stringify(record));
    } catch {
      throw new Error("Η αποθήκευση απέτυχε. Έλεγξε τον διαθέσιμο χώρο και δοκίμασε ξανά.");
    }
    loadData();
  }

  function say(message) {
    const el = $("toast");
    clearTimeout(toastTimer);
    el.textContent = message;
    el.hidden = false;
    toastTimer = setTimeout(() => { el.hidden = true; }, 3000);
  }

  function readRoute() {
    const hash = location.hash.slice(1);
    if (hash === "calendar" || hash.startsWith("calendar/")) {
      const date = hash.split("/")[1];
      if (validDay(date)) selectedDay = date;
      return { view: "calendar" };
    }
    if (hash.startsWith("book/")) {
      const book = books.find(b => b.id === hash.slice(5));
      if (book) return { view: "book", book };
    }
    return { view: "notes" };
  }

  function bookFor(id) {
    return books.find(b => b.id === id) || presets[2];
  }

  function newNoteButton() {
    return `<button type="button" class="primary" data-new-note aria-label="Νέα σημείωση">${icon("plus")}<span>Νέα<span class="note-word"> σημείωση</span></span></button>`;
  }

  function covers() {
    return books.map(book => {
      const count = notes.filter(n => n.bookId === book.id).length;
      const total = count === 1 ? "1 σημείωση" : `${count} σημειώσεις`;
      return `<a class="book-cover color-${book.color}" href="#book/${book.id}">
        ${icon(book.icon, "cover-icon")}${icon("corner", "corner")}
        <span class="book-name">${html(book.name)}</span><span class="book-count">${total}</span></a>`;
    }).join("");
  }

  function titleOf(n) {
    if (n.title) return n.title;
    return n.kind === "list" ? "Λίστα" : n.text.split("\n")[0];
  }

  function noteCard(n) {
    const book = bookFor(n.bookId);
    const stamp = n.date ? `<span class="stamp">${icon("calendar")}${shortFmt.format(parseDay(n.date))}</span>` : "";
    const preview = n.title ? n.text : n.text.split("\n").slice(1).join("\n").trim();
    let content = preview ? `<p class="excerpt">${html(preview)}</p>` : "";
    if (n.kind === "list") {
      content = `<ul class="checklist">${n.items.map((item, i) =>
        `<li><label><input type="checkbox" data-check="${n.id}" data-index="${i}" ${item.done ? "checked" : ""}><span>${html(item.label)}</span></label></li>`
      ).join("")}</ul>`;
    }
    return `<article class="note color-${book.color}">
      <div class="note-head"><span class="book-tag">${html(book.name)}</span>${stamp}</div>
      <h3><button type="button" class="open-note" data-edit="${n.id}" aria-label="Επεξεργασία: ${html(titleOf(n))}"><span>${html(titleOf(n))}</span>${icon("pencil")}</button></h3>${content}</article>`;
  }

  function noteList(list, emptyMessage) {
    if (list.length) return `<div class="notes-list">${list.map(noteCard).join("")}</div>`;
    return `<div class="empty">${icon("pages")}<p>${html(emptyMessage)}</p></div>`;
  }

  function neighboringMonth(iso, step) {
    const date = parseDay(iso), day = date.getDate();
    date.setDate(1);
    date.setMonth(date.getMonth() + step);
    const last = new Date(date);
    last.setMonth(last.getMonth() + 1, 0);
    date.setDate(Math.min(day, last.getDate()));
    return localKey(date);
  }

  function calendarGrid(iso, mini = false) {
    const selected = parseDay(iso);
    const day = new Date(selected);
    day.setDate(1);
    const offset = (day.getDay() + 6) % 7;
    const last = new Date(day);
    last.setMonth(last.getMonth() + 1, 0);
    const cells = Math.ceil((offset + last.getDate()) / 7) * 7;
    day.setDate(1 - offset);
    const today = localKey(new Date());
    const dated = new Map();
    for (const n of notes) {
      if (!n.date) continue;
      if (!dated.has(n.date)) dated.set(n.date, []);
      dated.get(n.date).push(n);
    }
    const days = [];
    for (let i = 0; i < cells; i++, day.setDate(day.getDate() + 1)) {
      const date = localKey(day);
      if (!validDay(date)) { days.push("<span></span>"); continue; }
      const list = dated.get(date) || [];
      const dots = [...new Set(list.map(n => bookFor(n.bookId).color))].slice(0, 3);
      const isToday = date === today;
      const classes = ["day", day.getMonth() !== selected.getMonth() ? "outside" : "", isToday ? "today" : "", !mini && date === iso ? "selected" : ""].filter(Boolean).join(" ");
      const label = shortFmt.format(day) + (isToday ? ", σήμερα" : "") + (list.length ? `, ${list.length} ${list.length === 1 ? "σημείωση" : "σημειώσεις"}` : "");
      days.push(`<a class="${classes}" href="#calendar/${date}" aria-label="${label}" ${isToday ? 'aria-current="date"' : ""}>${day.getDate()}<span class="dots" aria-hidden="true">${dots.map(c => `<i class="color-${c}"></i>`).join("")}</span></a>`);
    }
    function arrow(step) {
      const dir = step < 0 ? "left" : "right";
      const target = neighboringMonth(iso, step);
      const label = step < 0 ? "Προηγούμενος μήνας" : "Επόμενος μήνας";
      return validDay(target) ? `<a class="icon-button" href="#calendar/${target}" aria-label="${label}">${icon(dir)}</a>` : "";
    }
    return `<section class="calendar-panel" aria-label="Μηνιαίο ημερολόγιο">
      <div class="calendar-top"><h2>${monthFmt.format(selected)}</h2><div class="month-buttons">${arrow(-1)}${arrow(1)}</div></div>
      <div class="weekdays" aria-hidden="true">${["Δε", "Τρ", "Τε", "Πε", "Πα", "Σα", "Κυ"].map(d => `<span>${d}</span>`).join("")}</div>
      <div class="days">${days.join("")}</div></section>`;
  }

  function render() {
    route = readRoute();
    const today = localKey(new Date());
    const todayUrl = "#calendar/" + today;
    $("today-shortcut").href = todayUrl;
    $("today-shortcut").lastElementChild.textContent = headerFmt.format(parseDay(today));
    $("today-shortcut").setAttribute("aria-label", "Σήμερα, " + shortFmt.format(parseDay(today)));
    for (const tab of ["notes", "calendar"]) {
      const active = tab === (route.view === "calendar" ? "calendar" : "notes");
      const link = $("nav-" + tab);
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    let page;
    if (route.view === "calendar") {
      const dated = notes.filter(n => n.date === selectedDay);
      page = `<div class="page-head"><h1>Ημερολόγιο</h1>${newNoteButton()}</div>
        <div class="calendar-layout">${calendarGrid(selectedDay)}
        <section><div class="section-head"><h2 class="selected-day-title">${dayFmt.format(parseDay(selectedDay))}</h2><a href="${todayUrl}" class="today-link">Σήμερα</a></div>
        ${noteList(dated, "Δεν έχεις σημειώσεις για αυτή τη μέρα.")}</section></div>`;
    } else if (route.view === "book") {
      const b = route.book;
      page = `<section class="book-view"><a href="#notes" class="back-link">${icon("back")}Όλα τα τετράδια</a>
        <div class="page-head"><div class="book-heading color-${b.color}">${icon(b.icon)}<h1>${html(b.name)}</h1></div>${newNoteButton()}</div>
        ${noteList(notes.filter(n => n.bookId === b.id), "Δεν έχεις γράψει ακόμα σε αυτό το τετράδιο.")}</section>`;
    } else {
      page = `<div class="page-head"><h1>Σημειώσεις</h1>${newNoteButton()}</div>
        <section><div class="section-head"><h2>Τα τετράδιά μου</h2><button class="text-action" type="button" data-new-book>${icon("plus")}Τετράδιο</button></div>
        <div class="book-grid">${covers()}</div></section>
        <div class="home-lower"><section><div class="section-head"><h2>Πρόσφατες σημειώσεις</h2></div>${noteList(notes, "Οι σημειώσεις σου θα εμφανίζονται εδώ.")}</section>
        <aside class="mini-calendar"><div class="section-head"><h2>Ημερολόγιο</h2><a href="${todayUrl}" class="text-action" aria-label="Άνοιγμα ημερολογίου">${icon("arrow")}</a></div>${calendarGrid(today, true)}</aside></div>`;
    }
    main.innerHTML = (storageMessage ? `<p class="storage-error" role="alert">${storageMessage}</p>` : "") + page;
    document.title = (route.view === "book" ? route.book.name : route.view === "calendar" ? "Ημερολόγιο" : "Σημειώσεις") + " · Planner";
  }

  function formError(id, message = "") {
    const el = $(id);
    el.textContent = message;
    el.hidden = !message;
  }

  function updateBodyLabel() {
    const list = noteForm.elements.kind.value === "list";
    $("body-label").textContent = list ? "Στοιχεία λίστας · ένα ανά γραμμή" : "Σημείωση";
    $("note-body").placeholder = list ? "Ένα στοιχείο σε κάθε γραμμή…" : "Γράψε εδώ…";
  }

  function openEditor(id) {
    const n = id ? notes.find(note => note.id === id) : null;
    if (id && !n) { loadData(); render(); return; }
    const bookId = n?.bookId ?? route.book?.id ?? "personal";
    editing = n ? { note: n, original: rawNotes.get(id) } : null;
    kindChosen = !!n;
    noteForm.reset();
    $("note-heading").textContent = n ? "Επεξεργασία σημείωσης" : "Νέα σημείωση";
    $("note-book").replaceChildren(...books.map(b => new Option(b.name, b.id)));
    $("note-book").value = bookId;
    noteForm.elements.kind.value = n?.kind ?? (bookId === "shopping" ? "list" : "text");
    updateBodyLabel();
    $("note-title").value = n?.title ?? "";
    $("note-body").value = n?.kind === "list" ? n.items.map(item => item.label).join("\n") : n?.text ?? "";
    $("note-date").value = n?.date ?? (route.view === "calendar" ? selectedDay : "");
    $("delete-note").hidden = !n;
    formError("note-error");
    noteDialog.showModal();
    if (!n && noteForm.elements.kind.value === "list") $("note-body").focus();
  }

  function checklistItems(body, oldItems) {
    // Preserve checkmarks when an existing list is edited, including repeated labels.
    const matching = new Map();
    for (const item of oldItems) {
      if (!matching.has(item.label)) matching.set(item.label, []);
      matching.get(item.label).push(item.done);
    }
    return body.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
      .map(label => ({ label, done: matching.get(label)?.shift() ?? false }));
  }

  noteForm.addEventListener("submit", event => {
    event.preventDefault();
    const title = $("note-title").value.trim();
    const body = $("note-body").value.trim();
    const kind = noteForm.elements.kind.value;
    const date = $("note-date").value;
    if (!title && !body) {
      formError("note-error", "Γράψε έναν τίτλο ή λίγα λόγια για τη σημείωσή σου.");
      $("note-body").focus(); return;
    }
    if (date && !validDay(date)) {
      formError("note-error", "Διάλεξε μια έγκυρη ημερομηνία."); return;
    }
    try {
      const id = editing?.note.id ?? makeId();
      const next = {
        id, title, kind, date, bookId: $("note-book").value, text: kind === "text" ? body : "",
        items: kind === "list" ? checklistItems(body, editing?.note.items ?? []) : [], updated: Date.now()
      };
      write("note", id, next, editing?.original ?? null);
    } catch (error) { formError("note-error", error.message); return; }
    noteDialog.close();
    render();
    say("Η σημείωση αποθηκεύτηκε.");
  });

  $("delete-note").addEventListener("click", () => {
    if (!editing || !window.confirm("Να διαγραφεί η σημείωση «" + titleOf(editing.note) + "»;")) return;
    try { write("note", editing.note.id, null, editing.original); }
    catch (error) { formError("note-error", error.message); return; }
    noteDialog.close();
    render();
    say("Η σημείωση διαγράφηκε.");
  });

  noteForm.addEventListener("change", event => {
    if (event.target.name === "kind") { kindChosen = true; updateBodyLabel(); }
    if (event.target.id === "note-book" && !kindChosen && !$("note-body").value.trim()) {
      noteForm.elements.kind.value = event.target.value === "shopping" ? "list" : "text";
      updateBodyLabel();
    }
  });

  $("color-options").innerHTML = Object.entries(colors).map(([key, name], i) =>
    `<label class="swatch color-${key}" title="${name}"><input type="radio" name="color" value="${key}" aria-label="${name}" ${i === 0 ? "checked" : ""}><span>${icon("check")}</span></label>`
  ).join("");

  bookForm.addEventListener("submit", event => {
    event.preventDefault();
    const name = $("book-name").value.trim();
    if (!name || books.some(b => b.name.localeCompare(name, "el", { sensitivity: "base" }) === 0)) {
      formError("book-error", name ? "Υπάρχει ήδη τετράδιο με αυτό το όνομα." : "Δώσε όνομα στο τετράδιο."); return;
    }
    try {
      const id = makeId();
      write("book", id, { id, name, color: bookForm.elements.color.value, created: Date.now() }, null);
      bookDialog.close();
      location.hash = "book/" + id;
      say("Το τετράδιο δημιουργήθηκε.");
    } catch (error) { formError("book-error", error.message); }
  });

  main.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.hasAttribute("data-new-note")) openEditor();
    else if (button.dataset.edit) openEditor(button.dataset.edit);
    else if (button.hasAttribute("data-new-book")) {
      bookForm.reset(); formError("book-error"); bookDialog.showModal();
    }
  });

  main.addEventListener("change", event => {
    const box = event.target;
    if (!box.matches("[data-check]")) return;
    const n = notes.find(note => note.id === box.dataset.check);
    const index = Number(box.dataset.index);
    if (!n || !n.items[index]) return;
    const items = n.items.map((item, i) => i === index ? { ...item, done: box.checked } : item);
    try { write("note", n.id, { ...n, items, updated: Date.now() }, rawNotes.get(n.id)); }
    catch (error) { say(error.message); loadData(); }
    render();
    main.querySelector(`[data-check="${n.id}"][data-index="${index}"]`)?.focus({ preventScroll: true });
  });

  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => button.closest("dialog").close()));
  document.querySelector(".skip").addEventListener("click", event => {
    event.preventDefault();
    main.focus();
  });
  window.addEventListener("hashchange", () => {
    const previous = route;
    // Fragment navigation inside the month should keep the grid in view.
    render();
    if (previous.view !== route.view || previous.book?.id !== route.book?.id) {
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    }
  });
  window.addEventListener("storage", event => {
    if (!event.key || event.key.startsWith(prefix)) { loadData(); render(); }
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { loadData(); render(); }
  });

  loadData();
  render();
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

startPlanner();

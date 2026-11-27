async function startPlanner() {
  "use strict";

  const $ = id => document.getElementById(id);
  const main = $("content");
  const noteDialog = $("note-dialog");
  const bookDialog = $("book-dialog");
  const noteForm = $("note-form");
  const bookForm = $("book-form");
  const [{ colors, presets }, { openPlanner, legacyEntries, signIn, restoreSession, signOut }] = await Promise.all([
    import("./model.mjs"), import("./store.mjs")
  ]);
  let session;
  let restoreError="";
  try { session=await restoreSession(); } catch(error) { restoreError=error.message||"Δεν ήταν δυνατός ο έλεγχος σύνδεσης."; }
  if (!session) {
    const login=$("login-screen"), form=$("login-form"), error=$("login-error"), submit=$("login-submit");
    login.hidden=false;
    if(restoreError){error.textContent=restoreError;error.hidden=false;}
    session=await new Promise(resolve=>{
      form.addEventListener("submit",async event=>{
        event.preventDefault(); if(submit.disabled)return;
        submit.disabled=true; error.hidden=true;
        try {
          const token=await signIn($("login-username").value,$("login-password").value,$("login-remember")?.checked!==false);
          $("login-password").value=""; login.hidden=true; resolve(token);
        } catch(e) { error.textContent=e.message||"Αποτυχία σύνδεσης.";error.hidden=false; }
        finally {submit.disabled=false;}
      });
    });
  }
  $("planner-shell").hidden=false;
  $("logout").addEventListener("click",()=>{signOut();location.reload();});
  const unfiled = { id: "", name: "Χωρίς τετράδιο", color: "sky", icon: "pages" };
  const presetOrder = new Map(presets.map((book, index) => [book.id, index]));
  const presetIcons = new Map(presets.map(book => [book.id, book.icon]));
  const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const html = value => String(value ?? "").replace(/[&<>"']/g, ch => entities[ch]);
  const icon = (name, css = "") => `<svg class="${css}" aria-hidden="true"><use href="./icons.svg#${name}"/></svg>`;
  const makeId = () => crypto.randomUUID();

  const calFormat = options => new Intl.DateTimeFormat("el-GR", options);
  const monthFmt = calFormat({ month: "long", year: "numeric" });
  const dayFmt = calFormat({ weekday: "long", day: "numeric", month: "long" });
  const shortFmt = calFormat({ day: "numeric", month: "short", year: "numeric" });
  const headerFmt = calFormat({ weekday: "short", day: "numeric", month: "short" });
  const localKey = d => [String(d.getFullYear()).padStart(4, "0"), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")].join("-");
  const parseDay = iso => new Date(iso + "T12:00:00");
  const validDay = iso => typeof iso === "string" && /^\d{4}-\d\d-\d\d$/.test(iso) && !iso.startsWith("0000") && localKey(parseDay(iso)) === iso;

  let books = [...presets];
  let notes = [], foods = [];
  let foodDay = localKey(new Date()), foodEditing = null;
  const foodDialog = $("food-dialog"), foodForm = $("food-form");
  let versions = new Map();
  let store, reading = 0, statusTimer;
  let storageMessage = "";
  let route = { view: "notes" };
  let selectedDay = localKey(new Date());
  let editing = null;
  let kindChosen = false;
  let toastTimer;

  async function loadData() {
    const ticket = ++reading;
    const entries = store ? await store.all() : [
      ...presets.map(value => ({ key: "book:" + value.id, value })), ...legacyEntries()
    ];
    if (ticket !== reading) return;
    const loadedBooks = [], loadedNotes = [], loadedFoods = [], nextVersions = new Map();
    for (const { key, value, version } of entries) {
      if (!value) continue;
      nextVersions.set(key, version);
      if (key.startsWith("note:")) loadedNotes.push(value);
      else if (key.startsWith("food:")) loadedFoods.push(value);
      else if (key.startsWith("book:")) loadedBooks.push({ ...value, icon: presetIcons.get(value.id) || "pages" });
    }
    books = loadedBooks.sort((a, b) =>
      (presetOrder.get(a.id) ?? 4) - (presetOrder.get(b.id) ?? 4) ||
      a.created - b.created || a.name.localeCompare(b.name, "el"));
    notes = loadedNotes.sort((a, b) => b.updated - a.updated || a.id.localeCompare(b.id));
    foods = loadedFoods.sort((a,b)=>a.created-b.created || a.id.localeCompare(b.id));
    versions = nextVersions;
  }

  async function reload() { await loadData(); render(); }

  let localRefreshTimer;
  async function write(type, id, record, expected) {
    if (!store) throw new Error(storageMessage || "Η αποθήκευση δεν είναι ακόμη διαθέσιμη.");
    const saved = await store.save(type, id, record, expected);
    // An older cached store module may not return the committed row yet.
    if (!saved) { await loadData(); return; }
    // Show the committed record immediately, without reading the whole database.
    // Invalidate any older reload snapshot and reconcile again in the background.
    ++reading;
    const key = type + ":" + id;
    if (saved.value) versions.set(key, saved.version);
    else versions.delete(key);
    if (type === "book") {
      books = books.filter(b => b.id !== id);
      if (saved.value) books.push({...saved.value,icon:presetIcons.get(id)||"pages"});
      books.sort((a,b)=>(presetOrder.get(a.id)??4)-(presetOrder.get(b.id)??4)||a.created-b.created||a.name.localeCompare(b.name,"el"));
    } else if (type === "food") {
      foods = foods.filter(f=>f.id!==id);
      if(saved.value)foods.push(saved.value);
      foods.sort((a,b)=>a.created-b.created||a.id.localeCompare(b.id));
    } else {
      notes = notes.filter(n=>n.id!==id);
      if(saved.value)notes.push(saved.value);
      notes.sort((a,b)=>b.updated-a.updated||a.id.localeCompare(b.id));
    }
    clearTimeout(localRefreshTimer);
    localRefreshTimer=setTimeout(()=>reload().catch(()=>{}),150);
  }

  function saving(form, active) {
    if(active) {
      form.dataset.saving="1";
      form.setAttribute("aria-busy","true");
    } else {
      delete form.dataset.saving;
      form.removeAttribute("aria-busy");
    }
    for(const button of form.querySelectorAll('button[type="submit"],[data-close],.delete-button')){
      if(active){
        button.dataset.wasDisabled=button.disabled?"1":"0";
        button.disabled=true;
        if(button.type==="submit"){
          button.dataset.idleLabel=button.textContent;
          button.textContent="Αποθήκευση…";
        }
      } else {
        button.disabled=button.dataset.wasDisabled==="1";
        delete button.dataset.wasDisabled;
        if(button.dataset.idleLabel!==undefined){button.textContent=button.dataset.idleLabel;delete button.dataset.idleLabel;}
      }
    }
  }

  function syncStatus(state) {
    const el = $("sync-status");
    const messages = {
      ready: "Όλες οι αλλαγές συγχρονίστηκαν ✓",
      sending: "Αποθηκεύτηκε στη συσκευή · συγχρονισμός…",
      saved: "Αποθηκεύτηκε online ✓",
      pending: "Οι αλλαγές είναι στη συσκευή. Θα περάσουν στη βάση μόλις επανέλθει η σύνδεση.",
      unavailable: "Δεν υπάρχει σύνδεση με τον διακομιστή. Βλέπεις τα δεδομένα της συσκευής."
    };
    clearTimeout(statusTimer);
    el.textContent = messages[state] || "";
    el.dataset.state = state;
    el.hidden = !el.textContent;
    // Keep the last confirmed cloud status visible.
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
    if (hash === "food" || hash.startsWith("food/")) {
      const date = hash.split("/")[1];
      foodDay = validDay(date) ? date : localKey(new Date());
      return { view: "food" };
    }
    if (hash.startsWith("book/")) {
      const book = books.find(b => b.id === hash.slice(5));
      if (book) return { view: "book", book };
    }
    return { view: "notes" };
  }

  function bookFor(id) {
    return books.find(b => b.id === id) || unfiled;
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
    const isList = n.kind === "list";
    const stamp = n.date ? `<span class="stamp">${icon("calendar")}${shortFmt.format(parseDay(n.date))}</span>` : "";
    const preview = n.title ? n.text : n.text.split("\n").slice(1).join("\n").trim();
    let content = preview ? `<p class="excerpt">${html(preview)}</p>` : "";
    if (isList) {
      const total = n.items.length, done = n.items.filter(item => item.done).length;
      const percent = total ? Math.round(done / total * 100) : 0;
      const progress = total ? `<div class="note-progress${done === total ? " complete" : ""}"><div class="note-progress-label"><span>${done === total ? "Ολοκληρώθηκε" : "Πρόοδος λίστας"}</span><strong>${done}/${total}</strong></div><progress max="100" value="${percent}" aria-label="Ολοκληρωμένα στοιχεία: ${done} από ${total}"></progress></div>` : "";
      content = progress + `<ul class="checklist">${n.items.map((item, i) =>
        `<li><label><input type="checkbox" data-check="${n.id}" data-index="${i}" ${item.done ? "checked" : ""}><span>${html(item.label)}</span></label></li>`
      ).join("")}</ul>`;
    }
    return `<article class="note color-${book.color} ${isList ? "note-list-card" : "note-text-card"}" data-note-card="${n.id}">
      <div class="note-head"><span class="book-tag">${html(book.name)}</span><div class="note-meta"><span class="note-kind">${icon(isList ? "list" : "text")}${isList ? "Λίστα" : "Κείμενο"}</span>${stamp}</div></div>
      <h3><button type="button" class="open-note" data-edit="${n.id}" aria-label="Επεξεργασία: ${html(titleOf(n))}"><span>${html(titleOf(n))}</span><span class="note-edit-icon">${icon("pencil")}</span></button></h3>${content}</article>`;
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
    const foodDates = new Set(foods.map(f=>f.date));
    const days = [];
    for (let i = 0; i < cells; i++, day.setDate(day.getDate() + 1)) {
      const date = localKey(day);
      if (!validDay(date)) { days.push("<span></span>"); continue; }
      const list = dated.get(date) || [];
      const dots = [...new Set(list.map(n => bookFor(n.bookId).color))].slice(0, 3);
      const isToday = date === today;
      const classes = ["day", day.getMonth() !== selected.getMonth() ? "outside" : "", isToday ? "today" : "", !mini && date === iso ? "selected" : ""].filter(Boolean).join(" ");
      const hasFood = foodDates.has(date);
      const label = shortFmt.format(day) + (isToday ? ", σήμερα" : "") + (list.length ? `, ${list.length} ${list.length === 1 ? "σημείωση" : "σημειώσεις"}` : "") + (hasFood ? ", φαγητό" : "");
      days.push(`<a class="${classes}" href="#calendar/${date}" aria-label="${label}" ${isToday ? 'aria-current="date"' : ""}>${day.getDate()}<span class="dots" aria-hidden="true">${dots.map(c => `<i class="color-${c}"></i>`).join("")}${hasFood ? '<i class="food-dot"></i>' : ""}</span></a>`);
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
      <div class="days">${days.join("")}</div>${!mini ? '<p class="food-legend"><i></i> Καταγραφή φαγητού</p>' : ""}</section>`;
  }

  function foodList(day, compact = false) {
    const list = foods.filter(f=>f.date===day);
    const known = list.filter(f=>f.calories!==null);
    const total = known.reduce((sum,f)=>sum+f.calories,0);
    const summary = known.length ? total.toLocaleString("el-GR")+" kcal" : "—";
    return `<section class="food-panel">
      <div class="section-head"><h2>${icon("food")} Τι τρώω</h2><button class="text-action" type="button" data-food-add="${day}">${icon("plus")} Προσθήκη</button></div>
      <div class="food-total"><span>Καταγεγραμμένες θερμίδες <small>${list.length} καταχωρήσεις${known.length<list.length ? " · "+(list.length-known.length)+" χωρίς θερμίδες" : ""}</small></span><strong>${summary}</strong></div>
      ${list.length ? '<ul class="food-list">'+list.map(f=>`<li><span class="food-bullet"></span><div><strong>${html(f.name)}</strong><small>${f.calories===null ? "Χωρίς θερμίδες" : f.calories.toLocaleString("el-GR")+" kcal"}</small></div><button type="button" class="icon-button" data-food-edit="${f.id}" aria-label="Επεξεργασία: ${html(f.name)}">${icon("pencil")}</button></li>`).join("")+'</ul>' : '<p class="food-empty">Δεν έχεις καταχωρήσει φαγητό για αυτή τη μέρα.</p>'}
      ${compact ? `<a class="text-action" href="#food/${day}">Άνοιγμα ημερολογίου φαγητού ${icon("arrow")}</a>` : ""}
    </section>`;
  }
  function shiftDay(iso,step) {
    const d=parseDay(iso);d.setDate(d.getDate()+step);return localKey(d);
  }
  function renderFood(today) {
    const before=shiftDay(foodDay,-1), after=shiftDay(foodDay,1);
    return `<div class="page-head"><h1>Τι τρώω</h1><button class="primary" type="button" data-food-add="${foodDay}">${icon("plus")} Φαγητό</button></div>
      <div class="food-layout"><div class="food-date-bar"><a class="icon-button" href="#food/${validDay(before)?before:foodDay}" aria-label="Προηγούμενη ημέρα">${icon("left")}</a>
        <label class="field"><span>${foodDay===today?"Σήμερα":dayFmt.format(parseDay(foodDay))}</span><input id="food-day" type="date" min="0001-01-01" max="9999-12-31" value="${foodDay}" aria-label="Ημερομηνία φαγητού"></label>
        <a class="icon-button" href="#food/${validDay(after)?after:foodDay}" aria-label="Επόμενη ημέρα">${icon("right")}</a></div>
        <div class="food-links"><a class="text-action" href="#food/${today}">Σήμερα</a><a class="text-action" href="#calendar/${foodDay}">${icon("calendar")} Στο ημερολόγιο</a></div>
        ${foodList(foodDay)}</div>`;
  }

  function openFoodEditor(day,id) {
    if (!foodDialog || !foodForm) return;
    const existing=id ? foods.find(f=>f.id===id) : null;
    if(id&&!existing)return;
    foodEditing=existing ? {id,version:versions.get("food:"+id),created:existing.created} : null;
    foodForm.reset();
    $("food-heading").textContent=existing?"Επεξεργασία φαγητού":"Νέα καταχώρηση φαγητού";
    $("food-name").value=existing?.name??"";
    $("food-calories").value=existing?.calories??"";
    $("food-date").value=existing?.date??day;
    $("delete-food").hidden=!existing;
    formError("food-error");foodDialog.showModal();
  }
  foodForm?.addEventListener("submit",async event=>{
    event.preventDefault();
    if(foodForm.dataset.saving)return;
    const name=$("food-name").value.trim(),day=$("food-date").value,raw=$("food-calories").value;
    const calories=raw===""?null:Number(raw);
    if(!name||!validDay(day)||calories!==null&&(!Number.isSafeInteger(calories)||calories<0||calories>100000)){
      formError("food-error","Συμπλήρωσε φαγητό και έγκυρη ημερομηνία. Οι θερμίδες είναι προαιρετικές.");return;
    }
    formError("food-error"); saving(foodForm,true);
    try{
      const id=foodEditing?.id??makeId(),now=Date.now();
      await write("food",id,{id,name,date:day,calories,created:foodEditing?.created??now,updated:now},foodEditing?.version??null);
      foodDialog.close();
      location.hash=(route.view==="calendar"?"calendar/":"food/")+day;
      render();say("Το φαγητό αποθηκεύτηκε στη συσκευή ✓");
    }catch(error){formError("food-error",error.message);}
    finally{saving(foodForm,false);}
  });
  $("delete-food")?.addEventListener("click",async()=>{
    if(!foodEditing||foodForm.dataset.saving||!window.confirm("Να διαγραφεί αυτή η καταχώρηση φαγητού;"))return;
    formError("food-error"); saving(foodForm,true);
    try{await write("food",foodEditing.id,null,foodEditing.version);foodDialog.close();render();say("Η καταχώρηση διαγράφηκε.");}
    catch(error){formError("food-error",error.message);}
    finally{saving(foodForm,false);}
  });

  let renderedView = "", renderedTab = -1;
  let pageMotion, tabMotion;
  const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
  function animateNavigation(viewKey, tabIndex) {
    const nav = $("glass-nav") || document.querySelector(".main-nav");
    const previousTab = renderedTab;
    if (nav) nav.dataset.tab = String(tabIndex);
    if (renderedView !== viewKey) {
      pageMotion?.cancel();
      if (!reducedMotion() && typeof main.animate === "function") {
        const direction = previousTab < 0 || previousTab === tabIndex ? 0 : Math.sign(tabIndex-previousTab);
        pageMotion = main.animate([
          { opacity: .25, transform: "translate3d("+(direction*9)+"px,7px,0)" },
          { opacity: 1, transform: "translate3d(0,0,0)" }
        ],{ duration: 230, easing: "cubic-bezier(.2,.7,.25,1)" });
      }
      renderedView = viewKey;
    }
    if (previousTab >= 0 && previousTab !== tabIndex) {
      tabMotion?.cancel();
      const svg = nav?.querySelector('[aria-current="page"] svg');
      if (!reducedMotion() && typeof svg?.animate === "function") {
        tabMotion = svg.animate([
          { transform: "scale(.86) translateY(1px)" },
          { transform: "scale(1.16) translateY(-2px)", offset:.55 },
          { transform: "scale(1) translateY(0)" }
        ],{duration:360,easing:"cubic-bezier(.2,.7,.25,1)"});
      }
    }
    renderedTab = tabIndex;
  }

  function render() {
    route = readRoute();
    const today = localKey(new Date());
    const todayUrl = "#calendar/" + today;
    $("today-shortcut").href = todayUrl;
    $("today-shortcut").lastElementChild.textContent = headerFmt.format(parseDay(today));
    $("today-shortcut").setAttribute("aria-label", "Σήμερα, " + shortFmt.format(parseDay(today)));
    for (const tab of ["notes", "calendar", "food"]) {
      const active = tab === (route.view === "book" ? "notes" : route.view);
      const link = $("nav-" + tab);
      if (!link) continue;
      if (active) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
    let page;
    if (route.view === "calendar") {
      const dated = notes.filter(n => n.date === selectedDay);
      page = `<div class="page-head"><h1>Ημερολόγιο</h1>${newNoteButton()}</div>
        <div class="calendar-layout">${calendarGrid(selectedDay)}
        <section><div class="section-head"><h2 class="selected-day-title">${dayFmt.format(parseDay(selectedDay))}</h2><a href="${todayUrl}" class="today-link">Σήμερα</a></div>
        ${noteList(dated, "Δεν έχεις σημειώσεις για αυτή τη μέρα.")}
        ${foodList(selectedDay,true)}</section></div>`;
    } else if (route.view === "food") {
      page = renderFood(today);
    } else if (route.view === "book") {
      const b = route.book;
      page = `<section class="book-view"><div class="book-actions"><a href="#notes" class="back-link">${icon("back")}Όλα τα τετράδια</a>
        <button type="button" class="delete-button" data-delete-book>${icon("trash")}Διαγραφή τετραδίου</button></div>
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
    document.title = (route.view === "book" ? route.book.name : route.view === "calendar" ? "Ημερολόγιο" : route.view === "food" ? "Τι τρώω" : "Σημειώσεις") + " · Planner";
    const viewKey = route.view === "book" ? "book:"+route.book.id : route.view;
    animateNavigation(viewKey, route.view === "calendar" ? 1 : route.view === "food" ? 2 : 0);
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
    if (id && !n) { reload(); return; }
    const bookId = bookFor(n?.bookId ?? route.book?.id ?? "personal").id;
    editing = n ? { note: n, original: versions.get("note:" + id) } : null;
    kindChosen = !!n;
    noteForm.reset();
    $("note-heading").textContent = n ? "Επεξεργασία σημείωσης" : "Νέα σημείωση";
    $("note-book").replaceChildren(...[...books, unfiled].map(b => new Option(b.name, b.id)));
    $("note-book").value = bookId;
    noteForm.elements.kind.value = n?.kind ?? (bookId === "shopping" ? "list" : "text");
    updateBodyLabel();
    $("note-title").value = n?.title ?? "";
    $("note-body").value = n?.kind === "list" ? n.items.map(item => item.label).join("\n") : n?.text ?? "";
    $("note-date").value = n?.date ?? (route.view === "calendar" ? selectedDay : "");
    $("delete-note").hidden = !n;
    formError("note-error");
    noteDialog.showModal();
    // Let the user open the soft keyboard when ready.
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

  noteForm.addEventListener("submit", async event => {
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
    if (noteForm.dataset.saving) return;
    formError("note-error"); saving(noteForm,true);
    try {
      const id = editing?.note.id ?? makeId();
      const next = {
        id, title, kind, date, bookId: $("note-book").value, text: kind === "text" ? body : "",
        items: kind === "list" ? checklistItems(body, editing?.note.items ?? []) : [], updated: Date.now()
      };
      await write("note", id, next, editing?.original ?? null);
    } catch (error) { formError("note-error", error.message); return; }
    finally { saving(noteForm,false); }
    noteDialog.close();
    render();
    say("Η σημείωση αποθηκεύτηκε στη συσκευή ✓");
  });

  $("delete-note").addEventListener("click", async () => {
    if (!editing || noteForm.dataset.saving || !window.confirm("Να διαγραφεί η σημείωση «" + titleOf(editing.note) + "»;")) return;
    saving(noteForm,true);
    try { await write("note", editing.note.id, null, editing.original); }
    catch (error) { formError("note-error", error.message); return; }
    finally { saving(noteForm,false); }
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

  bookForm.addEventListener("submit", async event => {
    event.preventDefault();
    const name = $("book-name").value.trim();
    if (!name || books.some(b => b.name.localeCompare(name, "el", { sensitivity: "base" }) === 0)) {
      formError("book-error", name ? "Υπάρχει ήδη τετράδιο με αυτό το όνομα." : "Δώσε όνομα στο τετράδιο."); return;
    }
    if (bookForm.dataset.saving) return;
    formError("book-error"); saving(bookForm,true);
    try {
      const id = makeId();
      await write("book", id, { id, name, color: bookForm.elements.color.value, created: Date.now() }, null);
      bookDialog.close();
      location.hash = "book/" + id;
      say("Το τετράδιο δημιουργήθηκε στη συσκευή ✓");
    } catch (error) { formError("book-error", error.message); }
    finally { saving(bookForm,false); }
  });

  async function deleteBook() {
    if (route.view !== "book") return;
    const book = route.book;
    const hasNotes = notes.some(note => note.bookId === book.id);
    const message = "Να διαγραφεί το τετράδιο «" + book.name + "»;" +
      (hasNotes ? " Οι σημειώσεις του θα μείνουν στις Πρόσφατες ως «Χωρίς τετράδιο»." : "");
    if (!window.confirm(message)) return;
    try {
      await write("book", book.id, null, versions.get("book:" + book.id));
      location.hash = "notes";
      render();
      say("Το τετράδιο διαγράφηκε.");
    } catch (error) { say(error.message); }
  }

  main.addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.foodAdd) openFoodEditor(button.dataset.foodAdd);
    else if (button.dataset.foodEdit) openFoodEditor("",button.dataset.foodEdit);
    else if (button.hasAttribute("data-new-note")) openEditor();
    else if (button.dataset.edit) openEditor(button.dataset.edit);
    else if (button.hasAttribute("data-delete-book")) deleteBook();
    else if (button.hasAttribute("data-new-book")) {
      bookForm.reset(); formError("book-error"); bookDialog.showModal();
    }
  });

  main.addEventListener("change", async event => {
    const box = event.target;
    if (box.id==="food-day") { if(validDay(box.value))location.hash="food/"+box.value; return; }
    if (!box.matches("[data-check]")) return;
    const n = notes.find(note => note.id === box.dataset.check);
    const index = Number(box.dataset.index);
    if (!n || !n.items[index]) return;
    const items = n.items.map((item, i) => i === index ? { ...item, done: box.checked } : item);
    try { await write("note", n.id, { ...n, items, updated: Date.now() }, versions.get("note:" + n.id)); }
    catch (error) { say(error.message); await loadData(); }
    render();
    if (!reducedMotion()) {
      const card = main.querySelector(`[data-note-card="${n.id}"]`);
      card?.querySelector(".note-progress")?.animate?.([{opacity:.65,transform:"translateY(2px)"},{opacity:1,transform:"translateY(0)"}],{duration:240,easing:"ease-out"});
    }
    main.querySelector(`[data-check="${n.id}"][data-index="${index}"]`)?.focus({ preventScroll: true });
  });

  document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => {
    const dialog=button.closest("dialog");
    if(!dialog.querySelector("form")?.dataset.saving)dialog.close();
  }));
  for (const dialog of [noteDialog,foodDialog,bookDialog]) {
    dialog?.addEventListener("cancel",event=>{
      if(dialog.querySelector("form")?.dataset.saving)event.preventDefault();
    });
  }
  // Android Chrome may resize only the visual viewport when the IME is open.
  // Keep the footer within the visible area rather than behind the keyboard.
  const viewport=window.visualViewport;
  function fitViewport(){
    const height=viewport?.height||window.innerHeight;
    const offset=Math.max(0,window.innerHeight-height-(viewport?.offsetTop||0));
    document.documentElement.style.setProperty("--planner-visible-height",Math.round(height)+"px");
    document.documentElement.style.setProperty("--planner-keyboard-offset",Math.round(offset)+"px");
  }
  viewport?.addEventListener("resize",fitViewport);
  viewport?.addEventListener("scroll",fitViewport);
  window.addEventListener("resize",fitViewport);
  fitViewport();
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
  try { store = await openPlanner(session); }
  catch { storageMessage = "Ο browser δεν επέτρεψε την αποθήκευση στη συσκευή. Άνοιξε ξανά το Planner για να αποθηκεύσεις αλλαγές."; }
  await reload();
  store?.start(reload, syncStatus, say);
  const refreshButton = $("soft-refresh");
  if (refreshButton && typeof store?.refresh === "function") {
    refreshButton.disabled = false;
    refreshButton.addEventListener("click", async () => {
      if (refreshButton.disabled) return;
      refreshButton.disabled = true;
      refreshButton.setAttribute("aria-busy","true");
      try {
        const synced = await store.refresh();
        await reload();
        if (synced) {
          const time = new Intl.DateTimeFormat("el-GR",{hour:"2-digit",minute:"2-digit"}).format(new Date());
          refreshButton.title = "Τελευταία χειροκίνητη ανανέωση: " + time;
          say("Η ανανέωση ολοκληρώθηκε ✓");
        } else {
          say("Η ανανέωση δεν ολοκληρώθηκε. Οι τοπικές αλλαγές παραμένουν στη συσκευή.");
        }
      } catch {
        say("Η ανανέωση απέτυχε. Δοκίμασε ξανά.");
      } finally {
        refreshButton.removeAttribute("aria-busy");
        refreshButton.disabled = false;
      }
    });
  }
  if ("serviceWorker" in navigator && window.isSecureContext) {
    navigator.serviceWorker.register("./sw.js").catch(() => {});
  }
}

startPlanner().catch(() => {
  document.getElementById("content").textContent = "Το Planner δεν μπόρεσε να ανοίξει. Δοκίμασε ανανέωση της σελίδας.";
});

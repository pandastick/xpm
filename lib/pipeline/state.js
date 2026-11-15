// The little XPM writes itself: stamps ("the map matched the code on this day") and notes on steps.
// One small JSON file each, in XPM's own state folder, never in the project and never in git.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const NOTE_MAX = 2000;      // characters in one note
const NOTES_MAX = 500;      // notes kept per project
const NOTE_STEPS_MAX = 50;  // steps one note can be about

/** Reads never throw: a missing file, a broken file or an id that gets no file all read as "nothing there". */
function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file(), "utf-8"));
  } catch {
    return fallback;
  }
}

/** Write through a temp file and a rename, so a reader never sees half a file. */
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw err;
  }
}

// Project and pipeline ids become file names, so only plain names get a file.
const plain = (name) => typeof name === "string" && /^[A-Za-z0-9][\w.-]{0,79}$/.test(name);
function fileFor(dir, ...parts) {
  if (!parts.every(plain)) throw Object.assign(new Error("This project or pipeline id cannot be used as a file name, so XPM keeps no checks or notes for it."), { status: 400 });
  return `${path.join(dir, ...parts)}.json`;
}
const stampFile = (dir, project, pid) => fileFor(dir, "stamps", project, pid);
const notesFile = (dir, project) => fileFor(dir, "notes", project);

function readStamp(dir, project, pid) {
  const s = readJson(() => stampFile(dir, project, pid), null);
  return s && s.v === 1 && typeof s.takenAt === "string" && s.files && s.nodes ? s : null;
}
const writeStamp = (dir, project, pid, stamp) => writeJson(stampFile(dir, project, pid), stamp);

function allNotes(dir, project) {
  const d = readJson(() => notesFile(dir, project), null);
  return d && Array.isArray(d.notes) ? d.notes.filter((n) => n && typeof n.id === "string" && typeof n.text === "string" && Array.isArray(n.nodes)) : [];
}

/** The notes of one pipeline, newest first. */
function readNotes(dir, project, pid) {
  return allNotes(dir, project).filter((n) => n.pipeline === pid).sort((a, b) => String(b.at).localeCompare(String(a.at)));
}

// Line breaks stay; other control characters do not.
const cleanText = (t) => String(t).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();

/** Problems with a note someone wants to save, as sentences. Empty means it can be saved. */
function validateNote(pipeline, body) {
  const errors = [];
  if (!body || typeof body !== "object") return ["a note needs the steps it is about and a text"];
  const ids = new Set(pipeline.nodes.map((n) => n.id));
  if (!Array.isArray(body.nodes) || !body.nodes.length) errors.push("a note is about at least one step");
  else if (body.nodes.length > NOTE_STEPS_MAX) errors.push(`a note can be about ${NOTE_STEPS_MAX} steps at most`);
  else if (!body.nodes.every((id) => typeof id === "string" && ids.has(id))) errors.push("a note can only be about steps on this map");
  if (typeof body.text !== "string" || !cleanText(body.text)) errors.push("the note is empty");
  else if (cleanText(body.text).length > NOTE_MAX) errors.push(`a note holds ${NOTE_MAX} characters at most`);
  return errors;
}

function addNote(dir, project, pid, { nodes, text, by = "", now = new Date() }) {
  const notes = allNotes(dir, project);
  if (notes.length >= NOTES_MAX) throw Object.assign(new Error(`This project already holds ${NOTES_MAX} notes. Delete some first.`), { status: 409 });
  const note = { id: crypto.randomBytes(6).toString("hex"), pipeline: pid, at: now.toISOString(), by, nodes: [...new Set(nodes)], text: cleanText(text) };
  writeJson(notesFile(dir, project), { v: 1, notes: [...notes, note] });
  return note;
}

/** True when a note was there to delete. */
function removeNote(dir, project, pid, id) {
  const notes = allNotes(dir, project);
  const kept = notes.filter((n) => !(n.id === id && n.pipeline === pid));
  if (kept.length === notes.length) return false;
  writeJson(notesFile(dir, project), { v: 1, notes: kept });
  return true;
}

module.exports = { readStamp, writeStamp, readNotes, validateNote, addNote, removeNote, NOTE_MAX };

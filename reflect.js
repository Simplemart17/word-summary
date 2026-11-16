// Writing, checking and saving reflections, and answering follow-up questions.
// All of it is done by the Claude Code CLI, signed in with your subscription.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ANSWER_SCHEMA,
  REFLECTION_SCHEMA,
  REVIEW_SCHEMA,
  answerPrompt,
  answerSystem,
  lengthOf,
  reviewerPrompt,
  reviewerSystem,
  writerPrompt,
  writerSystem,
} from './prompt.js';
import { loadReflection, recordTitle, reflectionId, saveReflection } from './library.js';

export const MODEL = process.env.SELAH_MODEL || 'opus';
export const EFFORT = process.env.SELAH_EFFORT || 'medium';
// Every reflection is read a second time before it is shown. SELAH_REVIEW=off skips that.
export const REVIEW = process.env.SELAH_REVIEW !== 'off';
const TIMEOUT_MS = 180_000;
const QUESTION_MAX = 600;

export const CLAUDE_BIN = (() => {
  if (process.env.SELAH_CLAUDE_BIN) return process.env.SELAH_CLAUDE_BIN;
  const local = join(homedir(), '.claude', 'local', 'claude');
  return existsSync(local) ? local : 'claude';
})();

function askClaude({ system, schema, prompt }) {
  const args = [
    '--print',
    '--model', MODEL,
    '--effort', EFFORT,
    '--system-prompt', system,
    '--tools', '',
    '--strict-mcp-config',
    '--setting-sources', '',
    '--disable-slash-commands',
    '--no-session-persistence',
    '--output-format', 'json',
    '--json-schema', JSON.stringify(schema),
  ];

  // With an API key in the environment the CLI would bill that key instead of
  // the subscription it is signed in with, so the key is never passed on.
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;

  return new Promise((resolve, reject) => {
    const child = spawn(CLAUDE_BIN, args, { cwd: tmpdir(), env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error('Claude took too long to answer.'));
    }, TIMEOUT_MS);

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(
        err.code === 'ENOENT'
          ? new Error('The Claude Code CLI was not found. Install it, or set SELAH_CLAUDE_BIN to its path.')
          : err,
      );
    });
    child.on('close', () => {
      clearTimeout(timer);
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        return reject(new Error((stderr || stdout).trim().slice(0, 400) || 'Claude returned nothing.'));
      }
      if (result.is_error || !result.structured_output) {
        const said = typeof result.result === 'string' ? result.result.trim().slice(0, 400) : '';
        return reject(new Error(said || 'Claude did not return an answer.'));
      }
      resolve(result.structured_output);
    });
    child.stdin.end(prompt);
  });
}

const text = (value) => (typeof value === 'string' ? value.trim() : '');
const list = (value) => (Array.isArray(value) ? value : []);
const versesIn = (passage, numbers) => {
  const inPassage = new Set(passage.verses.map((v) => v.n));
  return [...new Set(list(numbers).filter((n) => inPassage.has(n)))].sort((a, b) => a - b);
};

// The schema is enforced by the CLI; this trims the result to what the page
// can show and drops verse numbers that fall outside the passage.
function tidy(raw, passage, options) {
  const { max } = lengthOf(options.length);
  return {
    title: text(raw?.title).replace(/\.$/, ''),
    setting: text(raw?.setting),
    summary: list(raw?.summary).map(text).filter(Boolean).slice(0, max.summary),
    lessons: list(raw?.lessons)
      .map((lesson) => ({
        heading: text(lesson?.heading).replace(/\.$/, ''),
        text: text(lesson?.text),
        verses: versesIn(passage, lesson?.verses),
      }))
      .filter((lesson) => lesson.heading && lesson.text)
      .slice(0, max.lessons),
    crossReferences: list(raw?.crossReferences)
      .map((ref) => ({ reference: text(ref?.reference), connection: text(ref?.connection) }))
      .filter((ref) => ref.reference && ref.connection)
      .slice(0, max.references),
    differences: text(raw?.differences),
    prayer: text(raw?.prayer),
  };
}

const complete = (reflection) => reflection.title && reflection.summary.length > 0 && reflection.lessons.length > 0;

// Writes a note, then has it read a second time. A note with small faults is
// corrected; one that is turned back is written again, once, with the reasons.
async function writeAndCheck(passage, options) {
  let feedback = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const draft = tidy(
      await askClaude({ system: writerSystem(options), schema: REFLECTION_SCHEMA, prompt: writerPrompt(passage, feedback) }),
      passage,
      options,
    );
    if (!complete(draft)) throw new Error('Claude returned an incomplete reflection.');
    if (!REVIEW) return { reflection: draft, review: { checked: false, corrections: [] } };

    const verdict = await askClaude({
      system: reviewerSystem(options),
      schema: REVIEW_SCHEMA,
      prompt: reviewerPrompt(passage, draft),
    });
    const issues = list(verdict.issues)
      .map((issue) => ({ where: text(issue?.where), problem: text(issue?.problem) }))
      .filter((issue) => issue.problem);

    if (verdict.verdict === 'sound') return { reflection: draft, review: { checked: true, corrections: [] } };
    if (verdict.verdict === 'corrected' && verdict.corrected) {
      const corrected = tidy(verdict.corrected, passage, options);
      if (complete(corrected)) return { reflection: corrected, review: { checked: true, corrections: issues } };
    }
    console.log(`[reflect] ${passage.reference}: draft ${attempt} turned back (${issues.length} issues)`);
    feedback = issues;
  }
  throw new Error(
    'Two drafts of the reflection were turned back by the check, so nothing is shown. Try again, or open another passage.',
  );
}

const writing = new Map(); // id -> Promise, so the same reflection is never written twice at once

// Returns the saved record for this passage and these options, writing it first if need be.
export function reflectionFor(passage, options) {
  const id = reflectionId(passage, options);
  const saved = loadReflection(id);
  if (saved) return Promise.resolve({ ...saved, fromLibrary: true });

  if (!writing.has(id)) {
    const work = writeAndCheck(passage, options)
      .then(({ reflection, review }) => {
        const record = {
          id,
          reference: passage.reference,
          translation: passage.translation.id,
          options,
          reflection,
          review,
          questions: [],
          writtenAt: new Date().toISOString(),
        };
        saveReflection(id, record);
        recordTitle(passage.key, reflection.title);
        return { ...record, fromLibrary: false };
      })
      .finally(() => writing.delete(id));
    writing.set(id, work);
  }
  return writing.get(id);
}

// Answers a question about a passage whose reflection already exists, and keeps the answer with it.
export async function answerQuestion(passage, options, question) {
  const asked = text(question).slice(0, QUESTION_MAX);
  if (!asked) throw new Error('Type a question first.');
  const id = reflectionId(passage, options);
  const record = loadReflection(id);
  if (!record) throw new Error('The reflection for this passage has not been written yet.');

  const raw = await askClaude({
    system: answerSystem(options),
    schema: ANSWER_SCHEMA,
    prompt: answerPrompt(passage, record.reflection, record.questions.slice(-4), asked),
  });
  const answer = list(raw.answer).map(text).filter(Boolean).slice(0, 4);
  if (!answer.length) throw new Error('Claude did not return an answer.');

  const entry = { question: asked, answer, verses: versesIn(passage, raw.verses), at: new Date().toISOString() };
  const latest = loadReflection(id) ?? record;
  latest.questions.push(entry);
  saveReflection(id, latest);
  return entry;
}

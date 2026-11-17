// The sign-in page. The window is the one on the app's opening screen, unlit.
// Each character typed lights one of its outer panes, and the right password
// lights the rest before the app opens.

import { RoseWindow } from './window.js';

const $ = (id) => document.getElementById(id);
const still = matchMedia('(prefers-reduced-motion: reduce)');

const rose = new RoseWindow($('window'), $('bloom'));
const panes = rose.wake();

const form = $('signin');
const field = $('password');
const enter = $('enter');
const show = $('show');
const problem = $('problem');

const lightTyped = () => rose.light(panes.slice(0, field.value.length));
field.addEventListener('input', () => {
  problem.textContent = '';
  lightTyped();
});
lightTyped(); // a password manager may have filled it in already

// Long passwords are hard to type blind on a phone.
show.hidden = false;
show.addEventListener('click', () => {
  const showing = field.type === 'text';
  field.type = showing ? 'password' : 'text';
  show.textContent = showing ? 'Show' : 'Hide';
  show.setAttribute('aria-pressed', String(!showing));
  field.focus();
});

function refuse(message) {
  rose.setWaiting(false);
  rose.light([]);
  problem.textContent = message;
  enter.disabled = false;
  enter.textContent = 'Open Selah';
  field.value = '';
  field.focus();
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (enter.disabled || !field.value) return;
  enter.disabled = true;
  enter.textContent = 'Opening';
  problem.textContent = '';
  rose.setWaiting(true);

  let response;
  try {
    response = await fetch('/login', {
      method: 'POST',
      headers: { Accept: 'application/json' },
      body: new URLSearchParams({ password: field.value }),
    });
  } catch {
    return refuse('Selah is not answering. Check your connection and try again.');
  }
  if (!response.ok) {
    const answer = await response.json().catch(() => ({}));
    return refuse(answer.error || 'That did not work. Try again.');
  }

  // The door is open: light the whole window, then go in.
  rose.light(panes);
  rose.reveal();
  $('caption').textContent = 'The window is lit.';
  if (still.matches) return location.replace('/');
  setTimeout(() => document.body.classList.add('leaving'), 1500);
  setTimeout(() => location.replace('/'), 2000);
});

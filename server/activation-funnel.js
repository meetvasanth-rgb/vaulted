'use strict';

// How far each new account gets: signs up, comes back, asks someone to connect, connects. Built only from what
// the server already keeps about an account (when it was created, when it was last active, and its connection
// requests), so it adds no tracking and never touches messages. Counts only: nobody is named.
//
// A request that nobody answered disappears when it expires, and a declined one is dropped from the sender,
// so "asked someone" is a floor, not an exact count, for accounts older than the request lifetime.

const DAY_MS = 24 * 60 * 60 * 1000;
const RETURN_AFTER_MS = DAY_MS;

const COHORTS = [
  { id:'7d', label:'Joined in the last 7 days', maxAgeMs:7 * DAY_MS },
  { id:'30d', label:'Joined in the last 30 days', maxAgeMs:30 * DAY_MS },
  { id:'all', label:'Everyone', maxAgeMs:Infinity },
];

function accountActivation(account, now) {
  const created = Number(account?.createdAt) || 0;
  const requests = Array.isArray(account?.connectionRequests) ? account.connectionRequests : [];
  const accepted = requests.some(request => request?.status === 'accepted');
  const outgoing = requests.filter(request => request?.direction === 'outgoing');
  const incoming = requests.filter(request => request?.direction === 'incoming');
  const returned = created > 0 && (Number(account?.lastActiveAt) || 0) >= created + RETURN_AFTER_MS;
  return {
    created,
    age:created ? now - created : Infinity,
    returned,
    sent:outgoing.length > 0 || accepted,
    connected:accepted,
    waitingForReply:!accepted && outgoing.some(request => request.status === 'pending'),
    receivedUnanswered:!accepted && incoming.some(request => request.status === 'pending')
      && !outgoing.some(request => request.status === 'pending'),
    notificationsOn:Array.isArray(account?.pushDestinations) && account.pushDestinations.length > 0,
  };
}

function summarize(entries) {
  // Accounts younger than a day have not had a chance to come back yet, so the percentages use the rest.
  const matured = entries.filter(entry => entry.age >= RETURN_AFTER_MS);
  const count = predicate => matured.filter(predicate).length;
  const connected = count(entry => entry.connected);
  const waitingForReply = count(entry => entry.waitingForReply);
  const receivedUnanswered = count(entry => entry.receivedUnanswered);
  const noRequests = matured.length - connected - waitingForReply - receivedUnanswered;
  const returnedNoRequests = count(entry => !entry.connected && !entry.waitingForReply && !entry.receivedUnanswered && entry.returned);
  return {
    created:entries.length,
    newToday:entries.length - matured.length,
    matured:matured.length,
    returned:count(entry => entry.returned),
    sentRequest:count(entry => entry.sent),
    connected,
    notificationsOn:count(entry => entry.notificationsOn),
    outcome:{
      connected,
      waitingForReply,
      receivedUnanswered,
      noRequestsButReturned:returnedNoRequests,
      neverCameBack:noRequests - returnedNoRequests,
    },
  };
}

function buildActivationFunnel(accounts, now = Date.now()) {
  const entries = [...accounts].map(account => accountActivation(account, now)).filter(entry => entry.created > 0);
  return {
    generatedAt:now,
    returnAfterHours:RETURN_AFTER_MS / (60 * 60 * 1000),
    cohorts:COHORTS.map(cohort => ({
      id:cohort.id, label:cohort.label,
      ...summarize(entries.filter(entry => entry.age <= cohort.maxAgeMs)),
    })),
  };
}

module.exports = { buildActivationFunnel, accountActivation, COHORTS, RETURN_AFTER_MS };

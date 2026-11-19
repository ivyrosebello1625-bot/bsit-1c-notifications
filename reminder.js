const admin = require('firebase-admin');

const rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT;
if (!rawServiceAccount) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT GitHub secret.');
const serviceAccount = JSON.parse(rawServiceAccount);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
const messaging = admin.messaging();

const REMINDERS = [
  { key: '1_week', ms: 7 * 24 * 60 * 60 * 1000, label: '1 week' },
  { key: '1_day', ms: 24 * 60 * 60 * 1000, label: '1 day' },
  { key: '3_hours', ms: 3 * 60 * 60 * 1000, label: '3 hours' },
  { key: 'deadline', ms: 0, label: 'deadline' }
];
const LOOKBACK_MS = 30 * 60 * 1000;
const LOOKAHEAD_MS = 5 * 60 * 1000;

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

async function main() {
  const now = Date.now();
  const [announcementsSnap, devicesSnap] = await Promise.all([
    db.collection('announcements').get(),
    db.collection('notificationDevices').get()
  ]);
  const devices = devicesSnap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(device => typeof device.token === 'string' && device.token.length > 20);

  if (!devices.length) {
    console.log('No registered notification devices yet.');
    return;
  }

  let sent = 0;
  for (const announcementDoc of announcementsSnap.docs) {
    const task = announcementDoc.data();
    if (!task.deadline || typeof task.deadline.toMillis !== 'function') continue;
    const deadlineMs = task.deadline.toMillis();
    if (!Number.isFinite(deadlineMs)) continue;

    for (const reminder of REMINDERS) {
      const targetMs = deadlineMs - reminder.ms;
      const age = now - targetMs;
      if (age < -LOOKAHEAD_MS || age > LOOKBACK_MS) continue;

      const logId = `${safeId(announcementDoc.id)}_${reminder.key}`;
      const logRef = db.collection('notificationLogs').doc(logId);
      const existing = await logRef.get();
      if (existing.exists) continue;

      const title = reminder.key === 'deadline'
        ? `Deadline today: ${task.title || 'Class task'}`
        : `Upcoming deadline in ${reminder.label}: ${task.title || 'Class task'}`;
      const body = `${task.subject || 'BSIT 1C'}${task.deadline.toDate ? ' · ' + task.deadline.toDate().toLocaleString('en-PH', { timeZone: 'Asia/Manila', dateStyle: 'medium', timeStyle: 'short' }) : ''}`;

      let delivered = 0;
      const failedDeviceIds = [];
      for (let i = 0; i < devices.length; i += 500) {
        const batch = devices.slice(i, i + 500);
        const response = await messaging.sendEachForMulticast({
          tokens: batch.map(device => device.token),
          notification: { title, body },
          data: {
            announcementId: announcementDoc.id,
            reminder: reminder.key,
            url: '/'
          },
          webpush: {
            fcmOptions: { link: '/' },
            notification: { icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' }
          }
        });
        delivered += response.successCount;
        response.responses.forEach((result, index) => {
          if (!result.success && result.error && [
            'messaging/registration-token-not-registered',
            'messaging/invalid-registration-token'
          ].includes(result.error.code)) failedDeviceIds.push(batch[index].id);
        });
      }

      const batch = db.batch();
      batch.set(logRef, {
        announcementId: announcementDoc.id,
        reminder: reminder.key,
        sentAt: admin.firestore.FieldValue.serverTimestamp(),
        successfulDeviceCount: delivered,
        attemptedDeviceCount: devices.length
      });
      for (const deviceId of failedDeviceIds) {
        batch.delete(db.collection('notificationDevices').doc(deviceId));
      }
      await batch.commit();
      sent += delivered;
      console.log(`Reminder ${reminder.key} for ${announcementDoc.id}: ${delivered}/${devices.length} devices accepted.`);
    }
  }
  console.log(`Finished. Successful FCM submissions: ${sent}`);
}

main().then(() => process.exit(0)).catch(error => {
  console.error(error);
  process.exit(1);
});

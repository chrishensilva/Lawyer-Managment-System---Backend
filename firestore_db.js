import { firestore } from "./firestore.js";

function normalizeOwnerId(id) {
  if (id === undefined || id === null) return id;
  const num = Number(id);
  return isNaN(num) ? String(id) : num;
}

function matchesOwner(docOwner, targetOwner) {
  if (docOwner === undefined || targetOwner === undefined) return false;
  return String(docOwner) === String(targetOwner);
}

function cleanSearchTerm(param) {
  if (typeof param !== 'string') return '';
  return param.replace(/^%+|%+$/g, '').trim().toLowerCase();
}

export const firestoreDb = {
  async execute(sql, params = []) {
    const trimmed = sql.trim();
    const upper = trimmed.toUpperCase();

    // 1. DDL Statements (CREATE TABLE, ALTER TABLE, DROP CONSTRAINT, information_schema)
    if (
      upper.startsWith("CREATE TABLE") ||
      upper.startsWith("ALTER TABLE") ||
      upper.startsWith("DROP ") ||
      upper.includes("INFORMATION_SCHEMA")
    ) {
      return [];
    }

    // 2. Count admin users for initialization
    if (upper.includes("SELECT COUNT(*) AS COUNT FROM USERS")) {
      const snap = await firestore.collection("users").get();
      return [{ count: snap.size }];
    }

    // 3. User Login & Registration
    // SELECT * FROM users WHERE username = ?
    if (upper.includes("FROM USERS WHERE USERNAME = ?")) {
      const username = params[0];
      const snap = await firestore.collection("users").where("username", "==", username).get();
      if (snap.empty) return [];
      const doc = snap.docs[0];
      return [{ id: doc.id, ...doc.data() }];
    }

    // SELECT username, email FROM users WHERE username = ? OR email = ?
    if (upper.includes("FROM USERS WHERE USERNAME = ? OR EMAIL = ?")) {
      const [username, email] = params;
      const snap1 = await firestore.collection("users").where("username", "==", username).get();
      const snap2 = await firestore.collection("users").where("email", "==", email).get();
      const map = new Map();
      snap1.docs.forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
      snap2.docs.forEach(d => map.set(d.id, { id: d.id, ...d.data() }));
      return Array.from(map.values());
    }

    // INSERT INTO users (username, email, password, role) / (username, email, password)
    if (upper.startsWith("INSERT INTO USERS")) {
      const username = params[0];
      const email = params[1];
      const password = params[2];
      const role = params[3] || 'admin';
      const userRef = firestore.collection("users").doc(username);
      const docData = {
        username,
        email,
        password,
        role,
        created_at: new Date().toISOString()
      };
      await userRef.set(docData, { merge: true });
      const result = [{ id: username, ...docData }];
      result.affectedRows = 1;
      result.insertId = username;
      return result;
    }

    // SELECT password FROM users WHERE id = ?
    if (upper.includes("SELECT PASSWORD FROM USERS WHERE ID = ?")) {
      const id = params[0];
      const doc = await firestore.collection("users").doc(String(id)).get();
      if (doc.exists) return [{ password: doc.data().password }];
      const snap = await firestore.collection("users").where("username", "==", String(id)).get();
      if (!snap.empty) return [{ password: snap.docs[0].data().password }];
      return [];
    }

    // UPDATE users SET password = ? WHERE id = ?
    if (upper.startsWith("UPDATE USERS SET PASSWORD = ? WHERE ID = ?")) {
      const [newPassword, id] = params;
      const docRef = firestore.collection("users").doc(String(id));
      const doc = await docRef.get();
      if (doc.exists) {
        await docRef.update({ password: newPassword });
      } else {
        const snap = await firestore.collection("users").where("username", "==", String(id)).get();
        if (!snap.empty) {
          await snap.docs[0].ref.update({ password: newPassword });
        }
      }
      return { affectedRows: 1 };
    }

    // 4. Editors
    // SELECT * FROM editors WHERE username = ?
    if (upper.includes("FROM EDITORS WHERE USERNAME = ?")) {
      const snap = await firestore.collection("editors").where("username", "==", params[0]).get();
      if (snap.empty) return [];
      const doc = snap.docs[0];
      return [{ id: doc.id, ...doc.data() }];
    }

    // SELECT id, username, permissions FROM editors WHERE owner_id = ?
    if (upper.includes("FROM EDITORS WHERE OWNER_ID = ?")) {
      const owner_id = params[0];
      const snap = await firestore.collection("editors").get();
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id));
    }

    // INSERT INTO editors
    if (upper.startsWith("INSERT INTO EDITORS")) {
      const [owner_id, username, password, permissions] = params;
      const docRef = await firestore.collection("editors").add({
        owner_id: normalizeOwnerId(owner_id),
        username,
        password,
        permissions,
        created_at: new Date().toISOString()
      });
      const res = [{ id: docRef.id }];
      res.affectedRows = 1;
      res.insertId = docRef.id;
      return res;
    }

    // DELETE FROM editors WHERE id = ? AND owner_id = ?
    if (upper.startsWith("DELETE FROM EDITORS WHERE ID = ? AND OWNER_ID = ?")) {
      const [id, owner_id] = params;
      const docRef = firestore.collection("editors").doc(String(id));
      const doc = await docRef.get();
      if (doc.exists && matchesOwner(doc.data().owner_id, owner_id)) {
        await docRef.delete();
      }
      return { affectedRows: 1 };
    }

    // 5. Dashboard Counts & Statistics
    // SELECT (SELECT COUNT(*) FROM userdata ...)
    if (upper.includes("TOTALCLIENTS") && upper.includes("TOTALLAWYERS")) {
      const owner_id = params[0];
      const casesSnap = await firestore.collection("userdata").get();
      const lawyersSnap = await firestore.collection("lawyerdata").get();

      const totalClients = casesSnap.docs.filter(d => matchesOwner(d.data().owner_id, owner_id)).length;
      const totalLawyers = lawyersSnap.docs.filter(d => matchesOwner(d.data().owner_id, owner_id)).length;
      return [{
        totalClients,
        totalLawyers,
        totalCases: totalClients
      }];
    }

    // SELECT casetype AS name, COUNT(*) AS value FROM userdata WHERE owner_id = ? GROUP BY casetype
    if (upper.includes("FROM USERDATA WHERE OWNER_ID = ? GROUP BY CASETYPE")) {
      const owner_id = params[0];
      const snap = await firestore.collection("userdata").get();
      const counts = {};
      snap.docs.forEach(d => {
        const data = d.data();
        if (matchesOwner(data.owner_id, owner_id)) {
          const type = (data.casetype || 'General').trim();
          counts[type] = (counts[type] || 0) + 1;
        }
      });
      return Object.entries(counts).map(([name, value]) => ({ name, value }));
    }

    // 6. User Cases / Clients (userdata)
    // getUserCases with assigned lawyers join
    if (upper.includes("FROM USERDATA U") && upper.includes("JOIN CASE_ASSIGNMENTS A")) {
      const owner_id = params[0];
      const casesSnap = await firestore.collection("userdata").get();
      const assignSnap = await firestore.collection("case_assignments").get();

      const assignments = {};
      assignSnap.docs.forEach(d => {
        const data = d.data();
        if (matchesOwner(data.owner_id, owner_id)) {
          assignments[data.user_nic] = data.lawyer_name;
        }
      });

      const results = casesSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id))
        .map(c => ({
          ...c,
          assigned_lawyer: assignments[c.nic] || c.lawyer1 || null
        }))
        .sort((a, b) => (a.next_date || '').localeCompare(b.next_date || ''));

      return results;
    }

    // COUNT total userdata (search)
    if (upper.includes("SELECT COUNT(*) AS TOTAL FROM USERDATA WHERE OWNER_ID = ?")) {
      const owner_id = params[0];
      const search = cleanSearchTerm(params[1]);
      const snap = await firestore.collection("userdata").get();
      const filtered = snap.docs
        .map(d => d.data())
        .filter(d => matchesOwner(d.owner_id, owner_id))
        .filter(d => {
          if (!search) return true;
          return (
            (d.nic && d.nic.toLowerCase().includes(search)) ||
            (d.name && d.name.toLowerCase().includes(search))
          );
        });
      return [{ total: filtered.length }];
    }

    // SELECT * FROM userdata WHERE owner_id = ? AND (nic LIKE ? OR name LIKE ?) LIMIT ? OFFSET ?
    if (upper.includes("FROM USERDATA WHERE OWNER_ID = ?") && upper.includes("LIMIT ? OFFSET ?")) {
      const [owner_id, searchRaw, , limit, offset] = params;
      const search = cleanSearchTerm(searchRaw);
      const snap = await firestore.collection("userdata").get();
      const filtered = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id))
        .filter(d => {
          if (!search) return true;
          return (
            (d.nic && d.nic.toLowerCase().includes(search)) ||
            (d.name && d.name.toLowerCase().includes(search))
          );
        })
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      const sliced = filtered.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 10));
      return sliced;
    }

    // SELECT * FROM userdata WHERE owner_id = ? ORDER BY next_date ASC (Report)
    if (upper.includes("FROM USERDATA WHERE OWNER_ID = ? ORDER BY NEXT_DATE ASC")) {
      const owner_id = params[0];
      const snap = await firestore.collection("userdata").get();
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id))
        .sort((a, b) => (a.next_date || '').localeCompare(b.next_date || ''));
    }

    // SELECT * FROM userdata WHERE nic = ? AND owner_id = ?
    if (upper.includes("FROM USERDATA WHERE NIC = ? AND OWNER_ID = ?")) {
      const [nic, owner_id] = params;
      const docRef = firestore.collection("userdata").doc(`${owner_id}_${nic}`);
      const doc = await docRef.get();
      if (doc.exists) return [{ id: doc.id, ...doc.data() }];
      const snap = await firestore.collection("userdata").get();
      const found = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => d.nic === nic && matchesOwner(d.owner_id, owner_id));
      return found;
    }

    // INSERT INTO userdata
    if (upper.startsWith("INSERT INTO USERDATA")) {
      const [owner_id, name, nic, email, number, address, lawyer1, lawyer2, lawyer3, last_date, next_date, note, casetype] = params;
      const docId = `${owner_id}_${nic}`;
      const docData = {
        owner_id: normalizeOwnerId(owner_id),
        name,
        nic,
        email,
        number,
        address: address || null,
        lawyer1: lawyer1 || null,
        lawyer2: lawyer2 || null,
        lawyer3: lawyer3 || null,
        last_date,
        next_date,
        note,
        casetype: casetype || null,
        status: 'ongoing',
        created_at: new Date().toISOString()
      };
      await firestore.collection("userdata").doc(docId).set(docData, { merge: true });
      const res = [{ nic }];
      res.affectedRows = 1;
      return res;
    }

    // UPDATE userdata SET ... WHERE nic=? AND owner_id=?
    if (upper.startsWith("UPDATE USERDATA SET NAME=?")) {
      const [name, email, number, address, lawyer1, lawyer2, lawyer3, last_date, next_date, note, casetype, status, nic, owner_id] = params;
      const docId = `${owner_id}_${nic}`;
      const updateData = {
        name,
        email,
        number,
        address: address || null,
        lawyer1: lawyer1 || null,
        lawyer2: lawyer2 || null,
        lawyer3: lawyer3 || null,
        last_date,
        next_date,
        note,
        casetype,
        status: status || 'ongoing',
        updated_at: new Date().toISOString()
      };
      await firestore.collection("userdata").doc(docId).set(updateData, { merge: true });
      return { affectedRows: 1 };
    }

    // UPDATE userdata SET status = ? WHERE nic = ? AND owner_id = ?
    if (upper.startsWith("UPDATE USERDATA SET STATUS = ? WHERE NIC = ? AND OWNER_ID = ?")) {
      const [status, nic, owner_id] = params;
      const docId = `${owner_id}_${nic}`;
      await firestore.collection("userdata").doc(docId).set({ status }, { merge: true });
      return { affectedRows: 1 };
    }

    // DELETE FROM userdata WHERE nic = ? AND owner_id = ?
    if (upper.startsWith("DELETE FROM USERDATA WHERE NIC = ? AND OWNER_ID = ?")) {
      const [nic, owner_id] = params;
      const docId = `${owner_id}_${nic}`;
      await firestore.collection("userdata").doc(docId).delete();
      return { affectedRows: 1 };
    }

    // 7. Lawyers (lawyerdata)
    // COUNT total lawyers (search)
    if (upper.includes("SELECT COUNT(*) AS TOTAL FROM LAWYERDATA WHERE OWNER_ID = ?")) {
      const owner_id = params[0];
      const search = cleanSearchTerm(params[1]);
      const snap = await firestore.collection("lawyerdata").get();
      const filtered = snap.docs
        .map(d => d.data())
        .filter(d => matchesOwner(d.owner_id, owner_id))
        .filter(d => {
          if (!search) return true;
          return (
            (d.nic && d.nic.toLowerCase().includes(search)) ||
            (d.name && d.name.toLowerCase().includes(search))
          );
        });
      return [{ total: filtered.length }];
    }

    // SELECT * FROM lawyerdata WHERE owner_id = ? AND (nic LIKE ? OR name LIKE ?) LIMIT ? OFFSET ?
    if (upper.includes("FROM LAWYERDATA WHERE OWNER_ID = ?") && upper.includes("LIMIT ? OFFSET ?")) {
      const [owner_id, searchRaw, , limit, offset] = params;
      const search = cleanSearchTerm(searchRaw);
      const snap = await firestore.collection("lawyerdata").get();
      const filtered = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id))
        .filter(d => {
          if (!search) return true;
          return (
            (d.nic && d.nic.toLowerCase().includes(search)) ||
            (d.name && d.name.toLowerCase().includes(search))
          );
        })
        .sort((a, b) => (a.name || '').localeCompare(b.name || ''));

      const sliced = filtered.slice(Number(offset) || 0, (Number(offset) || 0) + (Number(limit) || 10));
      return sliced;
    }

    // SELECT * FROM lawyerdata WHERE name = ? AND owner_id = ?
    if (upper.includes("FROM LAWYERDATA WHERE NAME = ? AND OWNER_ID = ?")) {
      const [name, owner_id] = params;
      const snap = await firestore.collection("lawyerdata").get();
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => d.name === name && matchesOwner(d.owner_id, owner_id));
    }

    // INSERT INTO lawyerdata
    if (upper.startsWith("INSERT INTO LAWYERDATA")) {
      const [owner_id, nic, name, email, contact, note] = params;
      const docId = `${owner_id}_${nic}`;
      const docData = {
        owner_id: normalizeOwnerId(owner_id),
        nic,
        name,
        email,
        contact,
        note,
        created_at: new Date().toISOString()
      };
      await firestore.collection("lawyerdata").doc(docId).set(docData, { merge: true });
      return { affectedRows: 1 };
    }

    // UPDATE lawyerdata SET name=?, email=?, contact=?, note=? WHERE nic=? AND owner_id=?
    if (upper.startsWith("UPDATE LAWYERDATA SET NAME=?")) {
      const [name, email, contact, note, nic, owner_id] = params;
      const docId = `${owner_id}_${nic}`;
      await firestore.collection("lawyerdata").doc(docId).set({ name, email, contact, note }, { merge: true });
      return { affectedRows: 1 };
    }

    // DELETE FROM lawyerdata WHERE nic = ? AND owner_id = ?
    if (upper.startsWith("DELETE FROM LAWYERDATA WHERE NIC = ? AND OWNER_ID = ?")) {
      const [nic, owner_id] = params;
      const docId = `${owner_id}_${nic}`;
      await firestore.collection("lawyerdata").doc(docId).delete();
      return { affectedRows: 1 };
    }

    // 8. Case Assignments
    if (upper.startsWith("INSERT INTO CASE_ASSIGNMENTS")) {
      const [owner_id, user_nic, lawyer_name, assigned_date] = params;
      const docId = `${owner_id}_${user_nic}`;
      await firestore.collection("case_assignments").doc(docId).set({
        owner_id: normalizeOwnerId(owner_id),
        user_nic,
        lawyer_name,
        assigned_date: assigned_date || new Date().toISOString()
      }, { merge: true });
      return { affectedRows: 1 };
    }

    if (upper.startsWith("DELETE FROM CASE_ASSIGNMENTS WHERE USER_NIC = ? AND OWNER_ID = ?")) {
      const [user_nic, owner_id] = params;
      const docId = `${owner_id}_${user_nic}`;
      await firestore.collection("case_assignments").doc(docId).delete();
      return { affectedRows: 1 };
    }

    // 9. Case Documents
    if (upper.startsWith("INSERT INTO CASE_DOCUMENTS")) {
      const [owner_id, user_nic, file_name, file_path] = params;
      const docRef = await firestore.collection("case_documents").add({
        owner_id: normalizeOwnerId(owner_id),
        user_nic,
        file_name,
        file_path,
        uploaded_at: new Date().toISOString()
      });
      const res = [{ id: docRef.id }];
      res.affectedRows = 1;
      res.insertId = docRef.id;
      return res;
    }

    if (upper.includes("FROM CASE_DOCUMENTS WHERE USER_NIC = ? AND OWNER_ID = ?")) {
      const [user_nic, owner_id] = params;
      const snap = await firestore.collection("case_documents").get();
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => d.user_nic === user_nic && matchesOwner(d.owner_id, owner_id))
        .sort((a, b) => (b.uploaded_at || '').localeCompare(a.uploaded_at || ''));
    }

    if (upper.startsWith("DELETE FROM CASE_DOCUMENTS WHERE ID = ? AND OWNER_ID = ?")) {
      const [id, owner_id] = params;
      const docRef = firestore.collection("case_documents").doc(String(id));
      const doc = await docRef.get();
      if (doc.exists && matchesOwner(doc.data().owner_id, owner_id)) {
        await docRef.delete();
      }
      return { affectedRows: 1 };
    }

    // 10. Todo
    if (upper.includes("FROM TODO WHERE OWNER_ID = ?")) {
      const owner_id = params[0];
      const snap = await firestore.collection("todo").get();
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id))
        .sort((a, b) => {
          const dtA = `${a.date || ''} ${a.time || ''}`;
          const dtB = `${b.date || ''} ${b.time || ''}`;
          return dtA.localeCompare(dtB);
        });
    }

    if (upper.startsWith("INSERT INTO TODO")) {
      const [owner_id, task, date, time] = params;
      const docRef = await firestore.collection("todo").add({
        owner_id: normalizeOwnerId(owner_id),
        task,
        date,
        time,
        created_at: new Date().toISOString()
      });
      const res = [{ id: docRef.id }];
      res.affectedRows = 1;
      res.insertId = docRef.id;
      return res;
    }

    if (upper.startsWith("DELETE FROM TODO WHERE ID = ? AND OWNER_ID = ?")) {
      const [id, owner_id] = params;
      const docRef = firestore.collection("todo").doc(String(id));
      const doc = await docRef.get();
      if (doc.exists && matchesOwner(doc.data().owner_id, owner_id)) {
        await docRef.delete();
      }
      return { affectedRows: 1 };
    }

    // 11. Activity Log
    if (upper.startsWith("INSERT INTO ACTIVITY_LOG")) {
      const [owner_id, username, action, details] = params;
      await firestore.collection("activity_log").add({
        owner_id: normalizeOwnerId(owner_id),
        username,
        action,
        details,
        timestamp: new Date().toISOString()
      });
      return { affectedRows: 1 };
    }

    if (upper.includes("FROM ACTIVITY_LOG L") && upper.includes("ORDER BY L.TIMESTAMP DESC")) {
      const owner_id = params[0];
      const logsSnap = await firestore.collection("activity_log").get();
      const profilesSnap = await firestore.collection("user_profiles").get();

      const avatars = {};
      profilesSnap.docs.forEach(d => {
        const p = d.data();
        if (p.username) avatars[p.username] = p.avatar_url;
      });

      return logsSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id))
        .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
        .slice(0, 500)
        .map(l => ({ ...l, avatar_url: avatars[l.username] || null }));
    }

    // 12. Login History
    if (upper.startsWith("INSERT INTO LOGIN_HISTORY")) {
      const [owner_id, username, ip_address, device_type] = params;
      await firestore.collection("login_history").add({
        owner_id: normalizeOwnerId(owner_id),
        username,
        ip_address,
        device_type,
        timestamp: new Date().toISOString()
      });
      return { affectedRows: 1 };
    }

    if (upper.includes("FROM LOGIN_HISTORY WHERE OWNER_ID = ?")) {
      const owner_id = params[0];
      const snap = await firestore.collection("login_history").get();
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id))
        .sort((a, b) => (b.timestamp || '').localeCompare(a.timestamp || ''))
        .slice(0, 5);
    }

    // 13. User Profiles
    if (upper.includes("FROM USER_PROFILES WHERE OWNER_ID = ?")) {
      const owner_id = params[0];
      const snap = await firestore.collection("user_profiles").get();
      const profiles = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id));
      return profiles;
    }

    if (upper.startsWith("INSERT INTO USER_PROFILES")) {
      const [username, owner_id] = params;
      const docRef = firestore.collection("user_profiles").doc(username);
      const updateData = {
        username,
        owner_id: normalizeOwnerId(owner_id)
      };
      if (params.length >= 6) {
        updateData.fullname = params[2];
        updateData.email = params[3];
        updateData.phone = params[4];
        updateData.avatar_url = params[5];
      }
      await docRef.set(updateData, { merge: true });
      return { affectedRows: 1 };
    }

    // Update avatar or notifications
    if (upper.includes("UPDATE SET AVATAR_URL") || upper.includes("UPDATE SET NOTIFICATIONS")) {
      const [username, owner_id, value] = params;
      const docRef = firestore.collection("user_profiles").doc(username);
      const field = upper.includes("AVATAR_URL") ? { avatar_url: value } : { notifications: value };
      await docRef.set({ username, owner_id: normalizeOwnerId(owner_id), ...field }, { merge: true });
      return { affectedRows: 1 };
    }

    // 14. App Settings (SMTP, etc.)
    if (upper.includes("FROM APP_SETTINGS WHERE OWNER_ID = ? AND SETTING_KEY IN")) {
      const [owner_id, key1, key2] = params;
      const snap = await firestore.collection("app_settings").get();
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id) && (d.setting_key === key1 || d.setting_key === key2));
    }

    if (upper.includes("FROM APP_SETTINGS WHERE OWNER_ID = ? AND SETTING_KEY = ?")) {
      const [owner_id, setting_key] = params;
      const snap = await firestore.collection("app_settings").get();
      return snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(d => matchesOwner(d.owner_id, owner_id) && d.setting_key === setting_key);
    }

    if (upper.startsWith("INSERT INTO APP_SETTINGS")) {
      const [owner_id, setting_key, setting_value, is_encrypted] = params;
      const docId = `${owner_id}_${setting_key}`;
      await firestore.collection("app_settings").doc(docId).set({
        owner_id: normalizeOwnerId(owner_id),
        setting_key,
        setting_value,
        is_encrypted: !!is_encrypted
      }, { merge: true });
      return { affectedRows: 1 };
    }

    // 15. Subscriptions
    if (upper.includes("FROM SUBSCRIPTIONS WHERE OWNER_ID = ?")) {
      const owner_id = params[0];
      const doc = await firestore.collection("subscriptions").doc(String(owner_id)).get();
      if (doc.exists) return [doc.data()];
      const snap = await firestore.collection("subscriptions").get();
      const found = snap.docs
        .map(d => d.data())
        .filter(d => matchesOwner(d.owner_id, owner_id));
      return found;
    }

    if (upper.startsWith("INSERT INTO SUBSCRIPTIONS")) {
      const owner_id = params[0];
      const docRef = firestore.collection("subscriptions").doc(String(owner_id));
      const renewalDate = new Date();
      renewalDate.setDate(renewalDate.getDate() + 30);
      await docRef.set({
        owner_id: normalizeOwnerId(owner_id),
        plan_name: 'Professional',
        renewal_date: renewalDate.toISOString().split('T')[0],
        status: 'Active'
      }, { merge: true });
      return { affectedRows: 1 };
    }

    console.warn(`[Firestore DB] Unhandled SQL Query:\n${sql}\nParams:`, params);
    return [];
  }
};

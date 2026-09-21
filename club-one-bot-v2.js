/*
 * Club One Discord Bot v2
 * Cloudflare Workers + Discord Interactions + KV
 *
 * Required env:
 *   DISCORD_PUBLIC_KEY
 *   DISCORD_APPLICATION_ID
 *   DISCORD_GUILD_ID
 *   DISCORD_TOKEN
 * KV binding:
 *   APP_KV
 *
 * Cron recommendation: every minute.
 * All operational times/channels are stored in KV and editable with /settings.
 */

const API = "https://discord.com/api/v10";
const TZ = "Asia/Tokyo";
const CANDIDATE_ROLE_NAME = "本日参加候補";
const CATEGORY = { MEMBER: "member", SUPPORT: "support", TRIAL: "trial", GUEST: "guest", EXTERNAL: "external" };
const STATUS = { EXPECTED: "参加予定", FROM22: "22:00から参加可能", UNDECIDED: "未定", ABSENT: "不参加" };
const DAY_ANSWERS = [STATUS.EXPECTED, STATUS.FROM22, STATUS.UNDECIDED, STATUS.ABSENT];
const ACTIVITY_TIMES = ["22:00", "22:30", "23:00以降", "未定（連絡ください）", "不参加"];

const DEFAULTS = {
  weeklyChannelId: "",
  operationChannelId: "",
  announcementChannelId: "",
  weeklyStartDay: 5, // Friday, 0=Sunday
  weeklyStartHour: 20,
  weeklyStartMinute: 0,
  weeklyReminderDay: 0,
  weeklyReminderHour: 20,
  weeklyReminderMinute: 0,
  dayOfConfirmationHour: 12,
  dayOfConfirmationMinute: 5,
  candidateRoleId: "",
  formationList: ["4-3-3", "4-4-2", "3-4-2-1", "3-5-2", "4-2-3-1"],
};

const COMMANDS = [
  { name: "admin", description: "Club One 運営管理センター" },
  { name: "weekly", description: "今週の予定登録パネルを表示" },
  { name: "settings", description: "Bot設定を管理" },
  { name: "activity", description: "活動日を作成・管理", options: [
    { name: "date", description: "日付 YYYY-MM-DD", type: 3, required: true },
  ] },
  { name: "practice", description: "今日の練習を管理" },
  { name: "lineup", description: "スタメンメーカーを開く", options: [
    { name: "date", description: "日付 YYYY-MM-DD", type: 3, required: true },
  ] },
];

export default {
  async fetch(request, env) {
    try {
      if (request.method === "GET") {
        const url = new URL(request.url);
        if (url.pathname === "/register-commands") {
          await registerCommands(env);
          return text("Commands registered.");
        }
        return text("Club One Bot v2 is running!");
      }
      if (request.method !== "POST") return text("Method Not Allowed", 405);
      const signature = request.headers.get("X-Signature-Ed25519");
      const timestamp = request.headers.get("X-Signature-Timestamp");
      if (!signature || !timestamp) return text("Missing signature", 401);
      const body = await request.text();
      if (!(await verifySignature(body, signature, timestamp, env.DISCORD_PUBLIC_KEY))) return text("Invalid signature", 401);
      const interaction = JSON.parse(body);
      if (interaction.type === 1) return json({ type: 1 });
      if (interaction.type === 2) return await handleCommand(interaction, env);
      if (interaction.type === 3) return await handleComponent(interaction, env);
      if (interaction.type === 5) return await handleModal(interaction, env);
      return ephemeral("対応していない操作です。");
    } catch (e) {
      console.error(e);
      return ephemeral("❌ エラーが発生しました。運営に確認してください。");
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

// ============================================================
// Settings / storage
// ============================================================
async function getSettings(env) {
  const saved = await env.APP_KV.get("settings", "json");
  return { ...DEFAULTS, ...(saved || {}) };
}
async function saveSettings(env, settings) { await env.APP_KV.put("settings", JSON.stringify(settings)); }
async function getWeekly(env, weekKey) {
  const saved = await env.APP_KV.get(`weekly:${weekKey}`, "json");
  return { weekKey, days: {}, messageId: "", channelId: "", ...(saved || {}) };
}
async function saveWeekly(env, weekKey, data) { await env.APP_KV.put(`weekly:${weekKey}`, JSON.stringify(data)); }
async function getActivity(env, date) {
  const saved = await env.APP_KV.get(`activity:${date}`, "json");
  return { date, kind: "activity", status: "planning", participants: {}, lineup: null, ...(saved || {}) };
}
async function saveActivity(env, date, data) { await env.APP_KV.put(`activity:${date}`, JSON.stringify(data)); }
async function getPractice(env, date) {
  const saved = await env.APP_KV.get(`practice:${date}`, "json");
  return { date, kind: "practice", status: "not_started", participants: {}, lineup: null, ...(saved || {}) };
}
async function savePractice(env, date, data) { await env.APP_KV.put(`practice:${date}`, JSON.stringify(data)); }

// ============================================================
// Discord API helpers
// ============================================================
async function discordRequest(env, path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: { Authorization: `Bot ${env.DISCORD_TOKEN}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const textBody = await res.text();
  let data = null;
  try { data = textBody ? JSON.parse(textBody) : null; } catch { data = textBody; }
  if (!res.ok) throw new Error(`Discord API ${res.status}: ${textBody}`);
  return data;
}
async function sendMessage(env, channelId, content, components = [], extra = {}) {
  if (!channelId) return null;
  return discordRequest(env, `/channels/${channelId}/messages`, { method: "POST", body: JSON.stringify({ content, components, ...extra }) });
}
async function editMessage(env, channelId, messageId, content, components = [], extra = {}) {
  if (!channelId || !messageId) return null;
  return discordRequest(env, `/channels/${channelId}/messages/${messageId}`, { method: "PATCH", body: JSON.stringify({ content, components, ...extra }) });
}
async function dm(env, userId, content, components = []) {
  const channel = await discordRequest(env, "/users/@me/channels", { method: "POST", body: JSON.stringify({ recipient_id: userId }) });
  return sendMessage(env, channel.id, content, components);
}
async function getGuildMember(env, userId) {
  try { return await discordRequest(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${userId}`); } catch { return null; }
}
async function getGuildRoles(env) { return await discordRequest(env, `/guilds/${env.DISCORD_GUILD_ID}/roles`); }
async function ensureCandidateRole(env, settings) {
  if (settings.candidateRoleId) return settings.candidateRoleId;
  const roles = await getGuildRoles(env);
  const role = roles.find(r => r.name === CANDIDATE_ROLE_NAME);
  if (!role) return "";
  settings.candidateRoleId = role.id;
  await saveSettings(env, settings);
  return role.id;
}
async function addCandidateRole(env, userId, roleId) {
  if (!roleId || !userId) return;
  try { await discordRequest(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`, { method: "PUT", body: "{}" }); } catch (e) { console.error("role add", e); }
}
async function removeCandidateRole(env, userId, roleId) {
  if (!roleId || !userId) return;
  try { await discordRequest(env, `/guilds/${env.DISCORD_GUILD_ID}/members/${userId}/roles/${roleId}`, { method: "DELETE" }); } catch (e) { console.error("role remove", e); }
}

// ============================================================
// Discord interaction helpers
// ============================================================
function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=UTF-8" } }); }
function text(content, status = 200) { return new Response(content, { status, headers: { "content-type": "text/plain; charset=UTF-8" } }); }
function ephemeral(content, components = []) { return json({ type: 4, data: { content, flags: 64, components } }); }
function messageResponse(content, components = []) { return json({ type: 4, data: { content, components } }); }
function updateResponse(content, components = []) { return json({ type: 7, data: { content, components } }); }
function modalResponse(customId, title, components) { return json({ type: 9, data: { custom_id: customId, title, components } }); }
function button(customId, label, style = 2, disabled = false) { return { type: 2, style, label, custom_id: customId, disabled }; }
function row(...components) { return { type: 1, components }; }
function textInput(customId, label, value = "", required = true, min = 0, max = 4000) { return { type: 1, components: [{ type: 4, custom_id: customId, label, style: 1, value, required, min_length: min, max_length: max }] }; }
function select(customId, placeholder, options, min = 1, max = 1) { return { type: 1, components: [{ type: 3, custom_id: customId, placeholder, min_values: min, max_values: max, options }] }; }
function getModalValues(components) {
  const out = {};
  for (const row of components || []) for (const c of row.components || []) out[c.custom_id] = c.value;
  return out;
}
function option(options, name) { return (options || []).find(x => x.name === name)?.value; }

// ============================================================
// Permissions / identity
// ============================================================
function interactionUser(i) { return i.member?.user || i.user || null; }
function memberRoles(i) { return i.member?.roles || []; }
async function isOperation(i, env) {
  const perms = BigInt(i.member?.permissions || "0");
  if ((perms & 8n) !== 0n) return true;
  const settings = await getSettings(env);
  const roleId = settings.operationRoleId || "";
  return !!roleId && memberRoles(i).includes(roleId);
}
function categoryFromMember(member, settings) {
  if (!member) return CATEGORY.EXTERNAL;
  if (settings.memberRoleId && member.roles?.includes(settings.memberRoleId)) return CATEGORY.MEMBER;
  if (settings.supportRoleId && member.roles?.includes(settings.supportRoleId)) return CATEGORY.SUPPORT;
  return CATEGORY.EXTERNAL;
}
function displayUser(user) { return user.global_name || user.username || "unknown"; }
function priority(c) { return ({ member: 1, support: 2, trial: 3, guest: 4 })[c] || 9; }

// ============================================================
// Commands
// ============================================================
async function handleCommand(i, env) {
  const name = i.data.name;
  if (name === "admin") return await commandAdmin(i, env);
  if (name === "weekly") return await commandWeekly(i, env);
  if (name === "settings") return await commandSettings(i, env);
  if (name === "activity") return await commandActivity(i, env, option(i.data.options, "date"));
  if (name === "practice") return await commandPractice(i, env);
  if (name === "lineup") return await commandLineup(i, env, option(i.data.options, "date"));
  return ephemeral("未対応のコマンドです。");
}

async function commandAdmin(i, env) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  return messageResponse(await buildAdminText(env), adminButtons());
}
async function commandWeekly(i, env) {
  const member = i.member;
  const settings = await getSettings(env);
  const cat = categoryFromMember(member, settings);
  if (![CATEGORY.MEMBER, CATEGORY.SUPPORT].includes(cat)) return ephemeral("週予定登録はメンバー・サポートメンバーのみです。");
  return messageResponse(await buildWeeklyText(env, getWeekKey(addDays(new Date(), 1))), weeklyPanelButtons(getWeekKey(addDays(new Date(), 1))));
}
async function commandSettings(i, env) {
  if (!(await isOperation(i, env))) return ephemeral("設定変更は運営のみ利用できます。");
  return ephemeral(await settingsText(env), settingsButtons());
}
async function commandActivity(i, env, date) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  return messageResponse(await buildActivityAdminText(env, date), activityAdminButtons(date));
}
async function commandPractice(i, env) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const date = todayJST();
  return messageResponse(await buildPracticeText(env, date), practiceButtons(date));
}
async function commandLineup(i, env, date) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  return await lineupScreen(i, env, date, "activity");
}

// ============================================================
// Components
// ============================================================
async function handleComponent(i, env) {
  const id = i.data.custom_id || "";
  if (id.startsWith("weekly-day:")) return weeklyDayPicker(i, env, id.split(":")[1]);
  if (id.startsWith("weekly-set:")) return setWeekly(i, env, id.split(":")[1], decodeURIComponent(id.split(":").slice(2).join(":")));
  if (id === "admin:weekly") return ephemeral(await buildWeeklyText(env, currentTargetWeek()), weeklyPanelButtons(currentTargetWeek()));
  if (id === "admin:practice") return messageResponse(await buildPracticeText(env, todayJST()), practiceButtons(todayJST()));
  if (id === "admin:settings") return ephemeral(await settingsText(env), settingsButtons());
  if (id === "admin:lineup") return ephemeral("スタメンは /lineup YYYY-MM-DD から開いてください。");
  if (id === "admin:activity-create") return modalResponse("activity-create", "活動日を作成", [textInput("date", "日付 YYYY-MM-DD", todayJST()), textInput("note", "メモ（任意）", "", false)]);
  if (id.startsWith("activity:open:")) return await activityOpen(i, env, id.split(":")[2]);
  if (id.startsWith("activity:start:")) return await activityStart(i, env, id.split(":")[2]);
  if (id.startsWith("activity:cancel:")) return await activityCancel(i, env, id.split(":")[2]);
  if (id.startsWith("activity:manage:")) return messageResponse(await buildActivityAdminText(env, id.split(":")[2]), activityManageButtons(id.split(":")[2]));
  if (id.startsWith("activity:add-person:")) return ephemeral("区分を選択してください。", [row(button(`activity:add-person-as:${id.split(":")[2]}:trial`, "体験", 3), button(`activity:add-person-as:${id.split(":")[2]}:guest`, "ゲスト", 2))]);
  if (id.startsWith("activity:add-person-as:")) return modalResponse(`activity-add-person:${id.split(":")[1]}:${id.split(":")[2]}`, "体験・ゲスト追加", [textInput("name", "名前"), textInput("time", "参加時間（任意）", "", false), textInput("note", "メモ（任意）", "", false)]);
  if (id.startsWith("activity:change:")) return activityChangePicker(i, env, id.split(":")[2]);
  if (id.startsWith("activity:confirm:")) return activityConfirmPicker(i, env, id.split(":")[2]);
  if (id.startsWith("activity:manual:")) return manualParticipantPicker(i, env, id.split(":")[2]);
  if (id.startsWith("activity:register:")) return activitySelfRegister(i, env, id.split(":")[2]);
  if (id.startsWith("activity:register-as:")) return activityRegisterAs(i, env, id.split(":")[2], id.split(":")[3]);
  if (id.startsWith("activity:post:")) return activityPostRecruitment(i, env, id.split(":")[2]);
  if (id.startsWith("activity:remove:")) return removeParticipant(i, env, id.split(":")[2], id.split(":")[3]);
  if (id.startsWith("activity:promote:")) return promoteCandidate(i, env, id.split(":")[2], id.split(":")[3]);
  if (id.startsWith("practice:start:")) return practiceStart(i, env, id.split(":")[2]);
  if (id.startsWith("practice:post:")) return practicePostRecruitment(i, env, id.split(":")[2]);
  if (id.startsWith("practice:status:")) return practiceStatusPicker(i, env, id.split(":")[2]);
  if (id.startsWith("practice:add:")) return ephemeral("区分を選択してください。", [row(button(`practice:add-as:${id.split(":")[2]}:trial`, "体験", 3), button(`practice:add-as:${id.split(":")[2]}:guest`, "ゲスト", 2))]);
  if (id.startsWith("practice:add-as:")) return modalResponse(`practice-add:${id.split(":")[1]}:${id.split(":")[2]}`, "体験・ゲスト追加", [textInput("name", "名前"), textInput("time", "参加時間（任意）", "", false), textInput("note", "メモ（任意）", "", false)]);
  if (id.startsWith("practice:register:")) return await practiceSelfRegister(i, env, id.split(":")[2]);
  if (id.startsWith("practice:register-as:")) return await practiceRegisterAs(i, env, id.split(":")[2], id.split(":")[3]);
  if (id.startsWith("practice:set-status:")) return await setPracticeStatus(i, env, id.split(":")[2], decodeURIComponent(id.split(":").slice(3).join(":")));
  if (id.startsWith("activity-manual-select:")) return await handleActivityManualSelect(i, env, id.split(":")[1], i.data.values?.[0]);
  if (id.startsWith("lineup:")) return await handleLineupComponent(i, env, id);
  if (id.startsWith("lineup-formation:")) return await lineupFormationSelect(i, env, id, i.data.values?.[0]);
  if (id.startsWith("lineup-player:")) return await lineupPlayerSelect(i, env, id, i.data.values?.[0]);
  if (id.startsWith("settings:")) return await handleSettingsComponent(i, env, id);
  return ephemeral("このボタンは現在利用できません。");
}

async function handleModal(i, env) {
  const id = i.data.custom_id || "";
  const values = getModalValues(i.data.components);
  if (id === "activity-create") {
    if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
    const date = values.date;
    if (!isDate(date)) return ephemeral("日付は YYYY-MM-DD で入力してください。");
    const a = await getActivity(env, date);
    a.date = date; a.kind = "activity"; a.status = "planning"; a.note = values.note || "";
    await saveActivity(env, date, a);
    return messageResponse(await buildActivityAdminText(env, date), activityAdminButtons(date));
  }
  if (id.startsWith("activity-add-person:")) {
    if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
    return await addExternalPerson(i, env, "activity", id.split(":")[1], { ...values, category: id.split(":")[2] });
  }
  if (id.startsWith("practice-add:")) {
    if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
    return await addExternalPerson(i, env, "practice", id.split(":")[1], { ...values, category: id.split(":")[2] });
  }
  if (id.startsWith("settings-save:")) return await saveSettingsModal(i, env, id.split(":")[1], values);
  return ephemeral("不明な入力です。");
}

// ============================================================
// Weekly registration
// ============================================================
function currentTargetWeek() { const p=getJstParts(new Date()); const d=parseJSTDate(`${p.year}-${pad(p.month)}-${pad(p.day)}`); const delta=7-p.weekday; d.setUTCDate(d.getUTCDate()+delta); return getWeekKey(d); }
async function weeklyDayPicker(i, env, date) {
  const settings = await getSettings(env);
  const cat = categoryFromMember(i.member, settings);
  if (![CATEGORY.MEMBER, CATEGORY.SUPPORT].includes(cat)) return ephemeral("週予定登録はメンバー・サポートメンバーのみです。");
  const w = await getWeekly(env, getWeekKey(parseJSTDate(date)));
  const current = w.days?.[date]?.[i.member.user.id]?.answer || "未登録";
  const buttons = [
    row(button(`weekly-set:${date}:${encodeURIComponent(STATUS.EXPECTED)}`, STATUS.EXPECTED, 3), button(`weekly-set:${date}:${encodeURIComponent(STATUS.FROM22)}`, STATUS.FROM22, 3)),
    row(button(`weekly-set:${date}:${encodeURIComponent(STATUS.UNDECIDED)}`, STATUS.UNDECIDED), button(`weekly-set:${date}:${encodeURIComponent(STATUS.ABSENT)}`, STATUS.ABSENT, 4)),
  ];
  return ephemeral(`📅 ${date}\n現在：**${current}**\n\n選択してください。`, buttons);
}
async function setWeekly(i, env, date, answer) {
  const settings = await getSettings(env);
  const cat = categoryFromMember(i.member, settings);
  if (![CATEGORY.MEMBER, CATEGORY.SUPPORT].includes(cat)) return ephemeral("週予定登録はメンバー・サポートメンバーのみです。");
  if (!DAY_ANSWERS.includes(answer)) return ephemeral("無効な回答です。");
  const weekKey = getWeekKey(parseJSTDate(date));
  const w = await getWeekly(env, weekKey);
  w.days[date] ||= {};
  const u = interactionUser(i);
  w.days[date][u.id] = { userId: u.id, username: displayUser(u), category: cat, answer, updatedAt: new Date().toISOString() };
  await saveWeekly(env, weekKey, w);
  return ephemeral(`✅ ${date} を「${answer}」に変更しました。`);
}
async function buildWeeklyText(env, weekKey) {
  const w = await getWeekly(env, weekKey);
  const dates = weekDates(weekKey);
  const lines = [`📅 **Club One 週間予定 — ${weekKey}**`, "", "各日を押して登録・変更してください。", ""];
  for (const d of dates) {
    const vals = Object.values(w.days[d] || {});
    const count = x => vals.filter(v => v.answer === x).length;
    lines.push(`**${weekdayLabel(d)} ${d}**　参加予定 ${count(STATUS.EXPECTED)} / 22:00〜 ${count(STATUS.FROM22)} / 未定 ${count(STATUS.UNDECIDED)} / 不参加 ${count(STATUS.ABSENT)}`);
  }
  return lines.join("\n");
}
function weeklyPanelButtons(weekKey) {
  return chunkRows(weekDates(weekKey).map(d => button(`weekly-day:${d}`, `${weekdayShort(d)} ${d.slice(5)}`, 2)), 5);
}

// ============================================================
// Activity self-registration / public recruitment
// ============================================================
async function activitySelfRegister(i, env, date) {
  const a = await getActivity(env, date);
  if (a.status !== "recruiting" && a.status !== "active") return ephemeral("現在募集していません。");
  const s = await getSettings(env);
  const u = interactionUser(i);
  const m = await getGuildMember(env, u.id);
  const cat = categoryFromMember(m, s);
  if (![CATEGORY.MEMBER, CATEGORY.SUPPORT].includes(cat)) return ephemeral("区分を選択してください。", [row(button(`activity:register-as:${date}:trial`, "体験", 3), button(`activity:register-as:${date}:guest`, "ゲスト", 2))]);
  a.participants[u.id] ||= { userId:u.id, name:displayUser(u), category:cat, time:"", source:"self", registeredAt:new Date().toISOString(), updatedAt:new Date().toISOString(), status:"candidate", manualOverride:false };
  recalcSoftOrder(a);
  await saveActivity(env,date,a);
  const roleId=await ensureCandidateRole(env,s); await addCandidateRole(env,u.id,roleId);
  return ephemeral(`✅ ${date} の活動に参加登録しました。\n当日昼ごろに参加時間を確認します。`);
}
async function activityPostRecruitment(i, env, date) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const s=await getSettings(env);
  if(!s.announcementChannelId) return ephemeral("先に /settings で告知チャンネルを設定してください。");
  const a=await getActivity(env,date);
  if(a.status==="planning") a.status="recruiting";
  await saveActivity(env,date,a);
  const msg=await sendMessage(env,s.announcementChannelId,`⚽ **Club One 活動日募集**\n\n📅 ${date}\n\n参加できる方は下の「参加登録」を押してください。\nメンバー・サポートは週予定の対象者が自動登録されています。`,[row(button(`activity:register:${date}`,"参加登録",3),button(`activity:change:${date}`,"登録変更"))]);
  a.recruitmentMessageId=msg?.id||a.recruitmentMessageId; await saveActivity(env,date,a);
  return ephemeral("✅ 告知チャンネルに募集パネルを投稿しました。");
}

// ============================================================
// Activity management
// ============================================================
async function activityOpen(i, env, date) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const a = await getActivity(env, date);
  if (a.status === "cancelled") return ephemeral("この活動日は中止されています。");
  a.status = "recruiting";
  const w = await getWeekly(env, getWeekKey(parseJSTDate(date)));
  const settings = await getSettings(env);
  const roleId = await ensureCandidateRole(env, settings);
  for (const answer of [STATUS.EXPECTED, STATUS.FROM22]) {
    for (const p of Object.values(w.days?.[date] || {})) {
      if (p.answer !== answer) continue;
      if (!a.participants[p.userId]) a.participants[p.userId] = participantFromWeekly(p, answer === STATUS.FROM22 ? "22:00" : null);
      if (roleId) await addCandidateRole(env, p.userId, roleId);
    }
  }
  recalcSoftOrder(a);
  await saveActivity(env, date, a);
  return messageResponse(await buildActivityAdminText(env, date), activityManageButtons(date));
}
async function activityStart(i, env, date) { return activityOpen(i, env, date); }
async function activityCancel(i, env, date) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const a = await getActivity(env, date); a.status = "cancelled"; await saveActivity(env, date, a);
  const settings = await getSettings(env); const roleId = await ensureCandidateRole(env, settings);
  for (const p of Object.values(a.participants)) if (p.userId && p.userId !== "external") await removeCandidateRole(env, p.userId, roleId);
  return messageResponse(await buildActivityAdminText(env, date), activityAdminButtons(date));
}
async function activityChangePicker(i, env, date) {
  const a = await getActivity(env, date); const u = interactionUser(i); const p = a.participants?.[u.id];
  if (!p) return ephemeral("この活動日の参加登録がありません。");
  return ephemeral(`📅 ${date}\n現在：**${p.time || "未確定"}**`, chunkRows(ACTIVITY_TIMES.map(t => button(`activity:confirm:${date}:${encodeURIComponent(t)}`, t, t === "不参加" ? 4 : 3)), 5));
}
async function activityConfirmPicker(i, env, date) {
  const parts = i.data.custom_id.split(":"); const value = decodeURIComponent(parts.slice(3).join(":"));
  const a = await getActivity(env, date); const u = interactionUser(i); const p = a.participants?.[u.id];
  if (!p) return ephemeral("この活動日の参加登録がありません。");
  p.time = value; p.updatedAt = new Date().toISOString();
  if (value === "不参加") { p.status = "cancelled"; } else { p.status = "candidate"; }
  recalcSoftOrder(a); await saveActivity(env, date, a);
  const settings = await getSettings(env); const roleId = await ensureCandidateRole(env, settings);
  if (value === "不参加") await removeCandidateRole(env, u.id, roleId); else await addCandidateRole(env, u.id, roleId);
  return ephemeral(`✅ ${date} を「${value}」に変更しました。`);
}
async function manualParticipantPicker(i, env, date) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const a = await getActivity(env, date);
  const opts = Object.values(a.participants).filter(p => p.status !== "cancelled").slice(0, 25).map(p => ({ label: `${p.name} / ${categoryLabel(p.category)}`.slice(0,100), value: p.userId }));
  if (!opts.length) return ephemeral("参加者がいません。");
  return ephemeral("操作する参加者を選択してください。", [select(`activity-manual-select:${date}`, "参加者", opts)]);
}
async function removeParticipant(i, env, date, userId) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const a = await getActivity(env, date); const p = a.participants?.[userId]; if (!p) return ephemeral("見つかりません。");
  p.status = "cancelled"; p.manualOverride = true; p.updatedAt = new Date().toISOString(); await saveActivity(env, date, a);
  if (userId && userId !== "external") { const s = await getSettings(env); await removeCandidateRole(env, userId, await ensureCandidateRole(env, s)); }
  return messageResponse(await buildActivityAdminText(env, date), activityManageButtons(date));
}
async function promoteCandidate(i, env, date, userId) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const a = await getActivity(env, date); const p = a.participants?.[userId]; if (!p) return ephemeral("見つかりません。");
  p.status = "confirmed"; p.manualOverride = true; p.updatedAt = new Date().toISOString();
  recalcSoftOrder(a); await saveActivity(env, date, a);
  return messageResponse(await buildActivityAdminText(env, date), activityManageButtons(date));
}
async function addExternalPerson(i, env, kind, date, values) {
  const data = kind === "activity" ? await getActivity(env, date) : await getPractice(env, date);
  const category = values.category === "trial" ? "trial" : "guest";
  const p = { id: crypto.randomUUID(), userId: "external", name: values.name, category, time: values.time || "", note: values.note || "", registeredAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: "candidate", external: true, manualOverride: true };
  data.participants[p.id] = p; recalcSoftOrder(data);
  if (kind === "activity") await saveActivity(env, date, data); else await savePractice(env, date, data);
  return messageResponse(kind === "activity" ? await buildActivityAdminText(env, date) : await buildPracticeText(env, date), kind === "activity" ? activityManageButtons(date) : practiceButtons(date));
}
function participantFromWeekly(p, time) { return { userId: p.userId, name: p.username, category: p.category, time: time || "", source: "weekly-auto", registeredAt: p.updatedAt, updatedAt: new Date().toISOString(), status: "candidate", manualOverride: false }; }
function recalcSoftOrder(data) {
  const all = Object.values(data.participants || {}).filter(p => p.status !== "cancelled");
  const fixed = all.filter(p => p.manualOverride && p.status === "confirmed");
  const flexible = all.filter(p => !(p.manualOverride && p.status === "confirmed") && !(p.manualOverride && p.status === "candidate"))
    .sort((a,b) => priority(a.category)-priority(b.category) || new Date(a.registeredAt)-new Date(b.registeredAt));
  const manualCandidates = all.filter(p => p.manualOverride && p.status === "candidate")
    .sort((a,b) => priority(a.category)-priority(b.category) || new Date(a.registeredAt)-new Date(b.registeredAt));
  for (const p of fixed) p.autoRank = 0;
  let slots = Math.max(0, 11 - fixed.length);
  let rank = 0;
  for (const p of flexible) {
    p.autoRank = ++rank;
    p.status = slots-- > 0 ? "confirmed" : "candidate";
  }
  for (const p of manualCandidates) p.autoRank = ++rank;
}

async function handleActivityManualSelect(i, env, date, userId) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const a=await getActivity(env,date); const p=a.participants?.[userId]; if(!p)return ephemeral("参加者が見つかりません。");
  return ephemeral(`${p.name} の操作を選択してください。`,[row(button(`activity:promote:${date}:${userId}`,"参加者に確定",3),button(`activity:remove:${date}:${userId}`,"参加取消",4))]);
}
async function setPracticeStatus(i, env, date, status) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  if(!["成立","中止"].includes(status))return ephemeral("無効な状態です。");
  const p=await getPractice(env,date); p.status=status; await savePractice(env,date,p);
  const s=await getSettings(env); if(s.announcementChannelId) await sendMessage(env,s.announcementChannelId,`🏃 **${date} 今日の練習：${status}**`);
  return messageResponse(await buildPracticeText(env,date),practiceButtons(date));
}

// ============================================================
// Practice
// ============================================================
async function practicePostRecruitment(i, env, date) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const s=await getSettings(env); if(!s.announcementChannelId)return ephemeral("先に /settings で告知チャンネルを設定してください。");
  const p=await getPractice(env,date); if(p.status==="not_started")p.status="recruiting";
  await savePractice(env,date,p);
  const msg=await sendMessage(env,s.announcementChannelId,`🏃 **Club One 今日の練習募集**\n\n📅 ${date}\n\n参加する方は「自分を参加登録」を押してください。`,[row(button(`practice:register:${date}`,"自分を参加登録",3))]);
  p.recruitmentMessageId=msg?.id||p.recruitmentMessageId; await savePractice(env,date,p);
  return ephemeral("✅ 告知チャンネルに練習募集パネルを投稿しました。");
}
async function practiceStart(i, env, date) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const p = await getPractice(env, date); p.status = "recruiting"; await savePractice(env, date, p);
  return messageResponse(await buildPracticeText(env, date), practiceButtons(date));
}
async function practiceSelfRegister(i, env, date) {
  const settings = await getSettings(env); const u = interactionUser(i); const member = await getGuildMember(env, u.id); const cat = categoryFromMember(member, settings);
  if (![CATEGORY.MEMBER, CATEGORY.SUPPORT].includes(cat)) return ephemeral("区分を選択してください。", [row(button(`practice:register-as:${date}:trial`, "体験", 3), button(`practice:register-as:${date}:guest`, "ゲスト", 2))]);
  return practiceRegisterAs(i, env, date, cat);
}
async function practiceRegisterAs(i, env, date, category) {
  const settings=await getSettings(env); const u=interactionUser(i); const p=await getPractice(env,date); if(p.status!=="recruiting")return ephemeral("現在募集していません。");
  if(![CATEGORY.MEMBER,CATEGORY.SUPPORT,CATEGORY.TRIAL,CATEGORY.GUEST].includes(category))return ephemeral("区分が不正です。");
  p.participants[u.id] ||= { userId:u.id,name:displayUser(u),category,time:"",registeredAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:"candidate",manualOverride:false };
  if(![CATEGORY.MEMBER,CATEGORY.SUPPORT].includes(category)) p.participants[u.id].category=category;
  recalcSoftOrder(p); await savePractice(env,date,p);
  const roleId=await ensureCandidateRole(env,settings); await addCandidateRole(env,u.id,roleId);
  return ephemeral(`✅ ${date} の練習に「${categoryLabel(category)}」として参加登録しました。`);
}
async function activityRegisterAs(i, env, date, category) {
  const s=await getSettings(env); const u=interactionUser(i); const a=await getActivity(env,date); if(!["recruiting","active"].includes(a.status))return ephemeral("現在募集していません。");
  if(![CATEGORY.TRIAL,CATEGORY.GUEST].includes(category))return ephemeral("区分が不正です。");
  a.participants[u.id] ||= {userId:u.id,name:displayUser(u),category,time:"",source:"self",registeredAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:"candidate",manualOverride:false};
  a.participants[u.id].category=category; recalcSoftOrder(a); await saveActivity(env,date,a);
  const roleId=await ensureCandidateRole(env,s); await addCandidateRole(env,u.id,roleId);
  return ephemeral(`✅ ${date} の活動に「${categoryLabel(category)}」として参加登録しました。`);
}
async function practiceStatusPicker(i, env, date) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  return ephemeral("練習の最終状態を選択してください。", [row(button(`practice:set-status:${date}:成立`, "練習成立", 3), button(`practice:set-status:${date}:中止`, "練習中止", 4))]);
}

// ============================================================
// Admin displays/buttons
// ============================================================
async function buildAdminText(env) {
  const week = currentTargetWeek();
  return [`⚽ **Club One 運営管理**`, ``, `📅 対象週：${week}`, ``, `週予定・活動日・練習日・参加者・スタメンをここから管理できます。`].join("\n");
}
function adminButtons() { return [row(button("admin:weekly", "週間予定"), button("admin:activity-create", "活動日作成", 3), button("admin:practice", "今日の練習")), row(button("admin:settings", "設定"), button("admin:lineup", "スタメン"))]; }
async function buildActivityAdminText(env, date) {
  const a = await getActivity(env, date); const active = Object.values(a.participants).filter(p=>p.status!=="cancelled");
  const confirmed = active.filter(p=>p.status==="confirmed"); const candidates = active.filter(p=>p.status==="candidate");
  const lines = [`⚽ **活動日管理**`, `📅 ${date}`, `状態：${activityStatusLabel(a.status)}`, ``, `🟢 参加者 ${confirmed.length}/11`];
  lines.push(...confirmed.map((p,n)=>`${n+1}. ${p.name} [${categoryLabel(p.category)}] ${p.time?`(${p.time})`:""}`));
  lines.push("", `🟡 候補 ${candidates.length}`);
  lines.push(...candidates.map((p,n)=>`${n+1}. ${p.name} [${categoryLabel(p.category)}] 登録:${formatTime(p.registeredAt)}`));
  return lines.join("\n");
}
function activityAdminButtons(date) { return [row(button(`activity:manage:${date}`, "参加者管理"), button(`activity:open:${date}`, "募集開始", 3), button(`activity:post:${date}`, "募集パネル投稿"), button(`activity:cancel:${date}`, "活動日中止", 4))]; }
function activityManageButtons(date) { return [row(button(`activity:add-person:${date}`, "体験・ゲスト追加", 3), button(`activity:manual:${date}`, "参加者操作"), button(`activity:change:${date}`, "自分の登録変更")), row(button(`activity:remove:${date}:__none__`, "取消操作"), button(`lineup:open:${date}:activity`, "スタメン"))]; }
async function buildPracticeText(env, date) {
  const p = await getPractice(env, date); const active = Object.values(p.participants).filter(x=>x.status!=="cancelled"); const confirmed=active.filter(x=>x.status==="confirmed"); const cand=active.filter(x=>x.status==="candidate");
  return [`🏃 **今日の練習**`, `📅 ${date}`, `状態：${practiceStatusLabel(p.status)}`, ``, `🟢 参加者 ${confirmed.length}/11`, ...confirmed.map((x,n)=>`${n+1}. ${x.name} [${categoryLabel(x.category)}]`), ``, `🟡 候補 ${cand.length}`, ...cand.map((x,n)=>`${n+1}. ${x.name} [${categoryLabel(x.category)}] 登録:${formatTime(x.registeredAt)}`)].join("\n");
}
function practiceButtons(date) { return [row(button(`practice:start:${date}`, "練習募集開始", 3), button(`practice:post:${date}`, "募集パネル投稿"), button(`practice:status:${date}`, "成立/中止"), button(`practice:add:${date}`, "体験・ゲスト追加", 3)), row(button(`practice:register:${date}`, "自分を参加登録"), button(`lineup:open:${date}:practice`, "スタメン"))]; }

// ============================================================
// Settings UI
// ============================================================
function settingsButtons() { return [row(button("settings:channels", "チャンネル設定"), button("settings:times", "時刻設定"), button("settings:roles", "ロール設定"))]; }
async function settingsText(env) {
  const s=await getSettings(env); return [`⚙️ **Club One Bot 設定**`,``,`予定登録：${s.weeklyChannelId||"未設定"}`,`運営管理：${s.operationChannelId||"未設定"}`,`告知：${s.announcementChannelId||"未設定"}`,``,`週予定開始：${s.weeklyStartDay}曜 ${pad(s.weeklyStartHour)}:${pad(s.weeklyStartMinute)}`,`リマインド：${s.weeklyReminderDay}曜 ${pad(s.weeklyReminderHour)}:${pad(s.weeklyReminderMinute)}`,`当日確認DM：${pad(s.dayOfConfirmationHour)}:${pad(s.dayOfConfirmationMinute)}`,``,`メンバーロール：${s.memberRoleId||"未設定"}`,`サポートロール：${s.supportRoleId||"未設定"}`,`運営ロール：${s.operationRoleId||"Administratorのみ"}`,`本日参加候補：${s.candidateRoleId||CANDIDATE_ROLE_NAME}`].join("\n");
}
async function handleSettingsComponent(i, env, id) {
  if (!(await isOperation(i, env))) return ephemeral("設定変更は運営のみ利用できます。");
  if (id === "settings:channels") return modalResponse("settings-save:channels", "チャンネル設定", [textInput("weeklyChannelId","予定登録用チャンネルID",(await getSettings(env)).weeklyChannelId,false),textInput("operationChannelId","運営管理チャンネルID",(await getSettings(env)).operationChannelId,false),textInput("announcementChannelId","告知チャンネルID",(await getSettings(env)).announcementChannelId,false)]);
  if (id === "settings:times") return modalResponse("settings-save:times", "自動処理時刻", [textInput("weeklyStart","週予定開始（曜日,HH:MM）","5,20:00"),textInput("weeklyReminder","リマインド（曜日,HH:MM）","0,20:00"),textInput("dayConfirm","当日確認DM（HH:MM）","12:05")]);
  if (id === "settings:roles") return modalResponse("settings-save:roles", "ロール設定", [textInput("memberRoleId","メンバーロールID",(await getSettings(env)).memberRoleId||"",false),textInput("supportRoleId","サポートロールID",(await getSettings(env)).supportRoleId||"",false),textInput("operationRoleId","運営ロールID",(await getSettings(env)).operationRoleId||"",false),textInput("candidateRoleId","本日参加候補ロールID",(await getSettings(env)).candidateRoleId||"",false)]);
  return ephemeral("設定項目が見つかりません。");
}
async function saveSettingsModal(i, env, section, v) {
  if (!(await isOperation(i, env))) return ephemeral("設定変更は運営のみ利用できます。");
  const s=await getSettings(env);
  if(section==="channels"){s.weeklyChannelId=v.weeklyChannelId||"";s.operationChannelId=v.operationChannelId||"";s.announcementChannelId=v.announcementChannelId||"";}
  if(section==="roles"){s.memberRoleId=v.memberRoleId||"";s.supportRoleId=v.supportRoleId||"";s.operationRoleId=v.operationRoleId||"";s.candidateRoleId=v.candidateRoleId||"";}
  if(section==="times"){
    const [d,h]=String(v.weeklyStart||"5,20:00").split(","); const [rd,rh]=String(v.weeklyReminder||"0,20:00").split(","); const [ch,cm]=String(v.dayConfirm||"12:05").split(":");
    s.weeklyStartDay=Number(d); [s.weeklyStartHour,s.weeklyStartMinute]=parseHM(h); s.weeklyReminderDay=Number(rd); [s.weeklyReminderHour,s.weeklyReminderMinute]=parseHM(rh); s.dayOfConfirmationHour=Number(ch);s.dayOfConfirmationMinute=Number(cm);
  }
  await saveSettings(env,s); return ephemeral("✅ 設定を保存しました。");
}

// ============================================================
// Lineup maker
// ============================================================
const FORMATIONS = {
  "4-3-3":["GK","RB","RCB","LCB","LB","RCM","CM","LCM","RW","ST","LW"],
  "4-4-2":["GK","RB","RCB","LCB","LB","RM","RCM","LCM","LM","ST1","ST2"],
  "3-4-2-1":["GK","RCB","CB","LCB","RM","RCM","LCM","LM","RAM","LAM","ST"],
  "3-5-2":["GK","RCB","CB","LCB","RM","RCM","CM","LCM","LM","ST1","ST2"],
  "4-2-3-1":["GK","RB","RCB","LCB","LB","RDM","LDM","RAM","CAM","LAM","ST"],
};
async function lineupScreen(i, env, date, kind) {
  const data=kind==="activity"?await getActivity(env,date):await getPractice(env,date); const players=Object.values(data.participants).filter(p=>p.status!=="cancelled"); const s=await getSettings(env);
  const formation=data.lineup?.formation||s.formationList[0];
  return messageResponse(`⚽ **スタメンメーカー**\n📅 ${date}\nフォーメーション：**${formation}**\n\n配置は運営が手動で行います。`, [select(`lineup-formation:${date}:${kind}`,"フォーメーション",s.formationList.map(f=>({label:f,value:f}))), select(`lineup-player:${date}:${kind}`,"配置する選手",players.slice(0,25).map(p=>({label:`${p.name} [${categoryLabel(p.category)}]`.slice(0,100),value:p.userId||p.id}))), row(button(`lineup-export:${date}:${kind}`,"PNG用データ表示"))]);
}
async function lineupFormationSelect(i, env, id, formation) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const [,date,kind]=id.split(":"); const data=kind==="activity"?await getActivity(env,date):await getPractice(env,date);
  data.lineup ||= {}; data.lineup.formation=formation; data.lineup.slots=data.lineup.slots||{};
  if(kind==="activity") await saveActivity(env,date,data); else await savePractice(env,date,data);
  return ephemeral(`✅ フォーメーションを ${formation} に変更しました。`);
}
async function lineupPlayerSelect(i, env, id, playerId) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  const [,date,kind]=id.split(":"); const data=kind==="activity"?await getActivity(env,date):await getPractice(env,date);
  const player=Object.values(data.participants).find(p=>(p.userId||p.id)===playerId); if(!player)return ephemeral("選手が見つかりません。");
  const formation=data.lineup?.formation||"4-3-3"; const slots=FORMATIONS[formation]||FORMATIONS["4-3-3"];
  const slot=slots.find(x=>!(data.lineup?.slots||{})[x])||slots[0]; data.lineup ||= {}; data.lineup.formation=formation; data.lineup.slots ||= {}; data.lineup.slots[slot]=playerId;
  if(kind==="activity") await saveActivity(env,date,data); else await savePractice(env,date,data);
  return ephemeral(`✅ ${player.name} を ${slot} に配置しました。\n※ 同じ選手の再配置・入れ替えUIは次の操作で上書きできます。`);
}
async function handleLineupComponent(i, env, id) {
  if (!(await isOperation(i, env))) return ephemeral("運営専用です。");
  if (id.startsWith("lineup:open:")) { const [, , date, kind]=id.split(":"); return await lineupScreen(i,env,date,kind); }
  if (id.startsWith("lineup-export:")) { const [,date,kind]=id.split(":"); return ephemeral(`🖼️ ${date} のスタメン画像生成用データを準備しました。\n現行WorkerではDiscord上の配置情報を保存し、PNG生成部分を次段で差し替え可能です。`); }
  return ephemeral("スタメン操作を処理できませんでした。");
}

// ============================================================
// Cron
// ============================================================
async function runCron(env) {
  const s=await getSettings(env); const now=new Date(); const j=getJstParts(now); const minute=j.hour*60+j.minute;
  const weekKey=currentTargetWeek();
  if(j.weekday===s.weeklyStartDay && minute===s.weeklyStartHour*60+s.weeklyStartMinute){ await postWeeklyPanel(env,weekKey); }
  if(j.weekday===s.weeklyReminderDay && minute===s.weeklyReminderHour*60+s.weeklyReminderMinute){ await sendWeeklyReminders(env,weekKey); }
  if(minute===s.dayOfConfirmationHour*60+s.dayOfConfirmationMinute){ await sendDayConfirmations(env,todayJST()); }
}
async function postWeeklyPanel(env,weekKey) {
  const s=await getSettings(env); if(!s.weeklyChannelId)return; const w=await getWeekly(env,weekKey); const msg=await sendMessage(env,s.weeklyChannelId,await buildWeeklyText(env,weekKey),weeklyPanelButtons(weekKey)); if(msg){w.messageId=msg.id;w.channelId=s.weeklyChannelId;w.lastAnnouncedAt=new Date().toISOString();await saveWeekly(env,weekKey,w);}
}
async function sendWeeklyReminders(env,weekKey) {
  const s=await getSettings(env); const w=await getWeekly(env,weekKey); const start=weekDates(weekKey)[0]; const end=weekDates(weekKey)[6]; const members=await listGuildMembers(env); for(const m of members){const cat=categoryFromMember(m,s);if(![CATEGORY.MEMBER,CATEGORY.SUPPORT].includes(cat))continue;const registered=weekDates(weekKey).some(d=>w.days[d]?.[m.user.id]);if(!registered)await dm(env,m.user.id,"📅 Club Oneの来週予定がまだ登録されていません。予定登録用チャンネルから登録してください。");}
}
async function sendDayConfirmations(env,date) {
  const a=await getActivity(env,date); if(a.status!=="recruiting"&&a.status!=="active")return; for(const p of Object.values(a.participants)){if(p.status==="cancelled"||p.external||p.time==="22:00")continue;if(p.source==="weekly-auto"&&p.userId)await dm(env,p.userId,`⚽ 本日のClub One活動\n📅 ${date}\n\n参加時間を選択してください。`,activityDmButtons(date));}
}
function activityDmButtons(date){return chunkRows(ACTIVITY_TIMES.map(t=>button(`activity:confirm:${date}:${encodeURIComponent(t)}`,t,t==="不参加"?4:3)),5);}
async function listGuildMembers(env){const out=[];for(let after="0";;){const page=await discordRequest(env,`/guilds/${env.DISCORD_GUILD_ID}/members?limit=1000&after=${after}`);if(!page.length)break;out.push(...page);if(page.length<1000)break;after=page[page.length-1].user.id;}return out;}

// ============================================================
// Registration / utilities
// ============================================================
async function registerCommands(env){return await discordRequest(env,`/applications/${env.DISCORD_APPLICATION_ID}/guilds/${env.DISCORD_GUILD_ID}/commands`,{method:"PUT",body:JSON.stringify(COMMANDS)});}
async function verifySignature(body, signature, timestamp, publicKey) {
  try {
    const key=await crypto.subtle.importKey("raw",hexToBytes(publicKey),{name:"Ed25519"},false,["verify"]);
    return await crypto.subtle.verify("Ed25519",key,hexToBytes(signature),new TextEncoder().encode(timestamp+body));
  } catch(e){console.error("signature",e);return false;}
}
function hexToBytes(hex){const b=new Uint8Array(hex.length/2);for(let i=0;i<b.length;i++)b[i]=parseInt(hex.slice(i*2,i*2+2),16);return b;}
function getJstParts(date){const parts=new Intl.DateTimeFormat("en-US",{timeZone:TZ,year:"numeric",month:"2-digit",day:"2-digit",hour:"2-digit",minute:"2-digit",weekday:"short",hour12:false}).formatToParts(date);const o={};for(const p of parts)o[p.type]=p.value;return {year:Number(o.year),month:Number(o.month),day:Number(o.day),hour:Number(o.hour)%24,minute:Number(o.minute),weekday:["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(o.weekday)};}
function todayJST(){const p=getJstParts(new Date());return `${p.year}-${pad(p.month)}-${pad(p.day)}`;}
function parseJSTDate(s){const [y,m,d]=s.split("-").map(Number);return new Date(Date.UTC(y,m-1,d,0,0,0));}
function getWeekKey(date){const p=getJstParts(date);const d=new Date(Date.UTC(p.year,p.month-1,p.day));const day=d.getUTCDay();const diff=(day+6)%7;d.setUTCDate(d.getUTCDate()-diff);return `${d.getUTCFullYear()}-${pad(d.getUTCMonth()+1)}-${pad(d.getUTCDate())}`;}
function weekDates(weekKey){const d=parseJSTDate(weekKey);return Array.from({length:7},(_,i)=>{const x=new Date(d);x.setUTCDate(d.getUTCDate()+i);return `${x.getUTCFullYear()}-${pad(x.getUTCMonth()+1)}-${pad(x.getUTCDate())}`;});}
function addDays(date,n){const d=new Date(date);d.setUTCDate(d.getUTCDate()+n);return d;}
function isDate(s){return /^\d{4}-\d{2}-\d{2}$/.test(s)&&!Number.isNaN(parseJSTDate(s).getTime());}
function pad(n){return String(n).padStart(2,"0");}
function parseHM(s){const [h,m]=String(s||"").split(":").map(Number);return [Number.isFinite(h)?h:0,Number.isFinite(m)?m:0];}
function weekdayShort(date){return ["日","月","火","水","木","金","土"][getJstParts(parseJSTDate(date)).weekday];}
function weekdayLabel(date){return weekdayShort(date);}
function categoryLabel(c){return ({member:"メンバー",support:"サポート",trial:"体験",guest:"ゲスト"})[c]||"外部";}
function activityStatusLabel(s){return ({planning:"活動日決定済み・募集前",recruiting:"募集受付中",active:"当日確認中",cancelled:"中止"})[s]||s;}
function practiceStatusLabel(s){return ({not_started:"未募集",recruiting:"募集受付中",成立:"練習成立",中止:"練習中止"})[s]||s;}
function formatTime(iso){try{return new Intl.DateTimeFormat("ja-JP",{timeZone:TZ,hour:"2-digit",minute:"2-digit"}).format(new Date(iso));}catch{return "--:--";}}
function chunkRows(items,n){const rows=[];for(let i=0;i<items.length;i+=n)rows.push(row(...items.slice(i,i+n)));return rows;}

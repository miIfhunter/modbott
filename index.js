const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } = require("discord.js");

const TOKEN          = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const UNIVERSE_ID    = process.env.UNIVERSE_ID;
const OPEN_CLOUD_KEY = process.env.OPEN_CLOUD_KEY;
const MOD_ROLE_ID    = process.env.MOD_ROLE_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const warnings = new Map();

async function getRobloxUserId(username) {
  const res = await fetch("https://users.roblox.com/v1/usernames/users", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ usernames: [username], excludeBannedUsers: false })
  });
  const data = await res.json();
  if (!data.data || data.data.length === 0) return null;
  return data.data[0].id;
}

async function getRobloxUserInfo(userId) {
  const res = await fetch(`https://users.roblox.com/v1/users/${userId}`);
  if (!res.ok) return null;
  return await res.json();
}

async function banRobloxUser(userId, reason, durationSeconds) {
  const body = { gameJoinRestriction: { active: true, privateReason: reason, displayReason: reason, excludeAltAccounts: false, inherited: true } };
  if (durationSeconds && durationSeconds > 0) body.gameJoinRestriction.duration = durationSeconds + "s";
  return await fetch(`https://apis.roblox.com/cloud/v2/universes/${UNIVERSE_ID}/user-restrictions/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-api-key": OPEN_CLOUD_KEY },
    body: JSON.stringify(body)
  });
}

async function unbanRobloxUser(userId) {
  return await fetch(`https://apis.roblox.com/cloud/v2/universes/${UNIVERSE_ID}/user-restrictions/${userId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", "x-api-key": OPEN_CLOUD_KEY },
    body: JSON.stringify({ gameJoinRestriction: { active: false } })
  });
}

async function kickRobloxUser(userId, reason) {
  const message = JSON.stringify({ type: "kick", userId: userId, reason: reason });
  return await fetch(`https://apis.roblox.com/messaging-service/v1/universes/${UNIVERSE_ID}/topics/Moderation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": OPEN_CLOUD_KEY },
    body: JSON.stringify({ message })
  });
}

function parseDuration(str) {
  if (!str || str === "perm" || str === "навсегда") return 0;
  const match = str.match(/^(\d+)(s|m|h|d)$/);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2];
  if (unit === "s") return val;
  if (unit === "m") return val * 60;
  if (unit === "h") return val * 3600;
  if (unit === "d") return val * 86400;
  return null;
}

function hasModRole(member) {
  if (!MOD_ROLE_ID) return member.permissions.has(PermissionFlagsBits.BanMembers);
  return member.roles.cache.has(MOD_ROLE_ID) || member.permissions.has(PermissionFlagsBits.Administrator);
}

const commands = [
  new SlashCommandBuilder().setName("ban").setDescription("Забанить игрока в Roblox")
    .addStringOption(o => o.setName("username").setDescription("Roblox никнейм").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Причина бана").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("Длительность: 1d / 2h / 30m / perm").setRequired(false)),
  new SlashCommandBuilder().setName("unban").setDescription("Разбанить игрока")
    .addStringOption(o => o.setName("username").setDescription("Roblox никнейм").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Причина").setRequired(false)),
  new SlashCommandBuilder().setName("kick").setDescription("Кикнуть игрока из игры")
    .addStringOption(o => o.setName("username").setDescription("Roblox никнейм").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Причина").setRequired(false)),
  new SlashCommandBuilder().setName("warn").setDescription("Выдать предупреждение")
    .addStringOption(o => o.setName("username").setDescription("Roblox никнейм").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Причина").setRequired(true)),
  new SlashCommandBuilder().setName("warnings").setDescription("Просмотр предупреждений")
    .addStringOption(o => o.setName("username").setDescription("Roblox никнейм").setRequired(true)),
  new SlashCommandBuilder().setName("userinfo").setDescription("Информация об игроке")
    .addStringOption(o => o.setName("username").setDescription("Roblox никнейм").setRequired(true)),
].map(c => c.toJSON());

client.once("ready", async () => {
  console.log(`✅ Бот запущен: ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ Команды зарегистрированы!");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!hasModRole(interaction.member)) return interaction.reply({ content: "❌ Нет прав!", ephemeral: true });
  await interaction.deferReply();
  const cmd = interaction.commandName;

  if (cmd === "ban") {
    const username = interaction.options.getString("username");
    const reason   = interaction.options.getString("reason");
    const durStr   = interaction.options.getString("duration") || "perm";
    const duration = parseDuration(durStr);
    if (duration === null) return interaction.editReply("❌ Формат времени неверный. Примеры: 1d, 12h, 30m, perm");
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Игрок **${username}** не найден`);
    const res = await banRobloxUser(userId, reason, duration);
    const embed = new EmbedBuilder().setColor(res.ok ? 0xff4444 : 0x888888)
      .setTitle(res.ok ? "🔨 Игрок забанен" : "❌ Ошибка бана")
      .addFields(
        { name: "Игрок", value: `${username} (ID: ${userId})`, inline: true },
        { name: "Причина", value: reason, inline: true },
        { name: "Длительность", value: duration === 0 ? "♾️ Навсегда" : durStr, inline: true },
        { name: "Модератор", value: interaction.user.tag, inline: true },
        { name: "Статус", value: res.ok ? "✅ Успешно" : `❌ Ошибка ${res.status}`, inline: true }
      ).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (cmd === "unban") {
    const username = interaction.options.getString("username");
    const reason   = interaction.options.getString("reason") || "—";
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Игрок **${username}** не найден`);
    const res = await unbanRobloxUser(userId);
    const embed = new EmbedBuilder().setColor(res.ok ? 0x44ff88 : 0x888888)
      .setTitle(res.ok ? "✅ Игрок разбанен" : "❌ Ошибка разбана")
      .addFields(
        { name: "Игрок", value: `${username} (ID: ${userId})`, inline: true },
        { name: "Причина", value: reason, inline: true },
        { name: "Модератор", value: interaction.user.tag, inline: true }
      ).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (cmd === "kick") {
    const username = interaction.options.getString("username");
    const reason   = interaction.options.getString("reason") || "Кик без причины";
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Игрок **${username}** не найден`);
    const res = await kickRobloxUser(userId, reason);
    const embed = new EmbedBuilder().setColor(res.ok ? 0xffaa00 : 0x888888)
      .setTitle(res.ok ? "👟 Кик отправлен" : "❌ Ошибка кика")
      .setDescription(res.ok ? "Сигнал отправлен в игру. Игрок будет кикнут если онлайн." : "")
      .addFields(
        { name: "Игрок", value: `${username} (ID: ${userId})`, inline: true },
        { name: "Причина", value: reason, inline: true },
        { name: "Модератор", value: interaction.user.tag, inline: true }
      ).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (cmd === "warn") {
    const username = interaction.options.getString("username");
    const reason   = interaction.options.getString("reason");
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Игрок **${username}** не найден`);
    if (!warnings.has(userId)) warnings.set(userId, []);
    const userWarns = warnings.get(userId);
    userWarns.push({ reason, moderator: interaction.user.tag, date: new Date().toLocaleString("ru-RU") });
    const embed = new EmbedBuilder().setColor(0xffdd00)
      .setTitle("⚠️ Предупреждение выдано")
      .addFields(
        { name: "Игрок", value: `${username} (ID: ${userId})`, inline: true },
        { name: "Причина", value: reason, inline: true },
        { name: "Всего варнов", value: `${userWarns.length}`, inline: true },
        { name: "Модератор", value: interaction.user.tag, inline: true }
      ).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (cmd === "warnings") {
    const username = interaction.options.getString("username");
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Игрок **${username}** не найден`);
    const userWarns = warnings.get(userId) || [];
    const embed = new EmbedBuilder().setColor(0x5865f2)
      .setTitle(`📋 Варны: ${username}`)
      .setDescription(userWarns.length === 0 ? "Предупреждений нет ✅" : userWarns.map((w, i) => `**${i+1}.** ${w.reason}\n👮 ${w.moderator} · 📅 ${w.date}`).join("\n\n"))
      .setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }

  if (cmd === "userinfo") {
    const username = interaction.options.getString("username");
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Игрок **${username}** не найден`);
    const info = await getRobloxUserInfo(userId);
    if (!info) return interaction.editReply("❌ Не удалось получить информацию");
    const userWarns = warnings.get(userId) || [];
    const embed = new EmbedBuilder().setColor(0x5865f2)
      .setTitle(`👤 ${info.displayName} (@${info.name})`)
      .setURL(`https://www.roblox.com/users/${userId}/profile`)
      .addFields(
        { name: "🆔 User ID", value: `${userId}`, inline: true },
        { name: "📅 Регистрация", value: info.created ? new Date(info.created).toLocaleDateString("ru-RU") : "—", inline: true },
        { name: "⚠️ Варнов", value: `${userWarns.length}`, inline: true }
      ).setTimestamp();
    return interaction.editReply({ embeds: [embed] });
  }
});

client.login(TOKEN);

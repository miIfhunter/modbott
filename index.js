const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits, ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType } = require("discord.js");
const fs = require("fs");
const path = require("path");

const TOKEN          = process.env.DISCORD_TOKEN;
const CLIENT_ID      = process.env.CLIENT_ID;
const UNIVERSE_ID    = process.env.UNIVERSE_ID;
const OPEN_CLOUD_KEY = process.env.OPEN_CLOUD_KEY;
const MOD_ROLE_ID    = process.env.MOD_ROLE_ID;
const ADMIN_ROLE_ID  = process.env.ADMIN_ROLE_ID;

const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const warnings = new Map();

// ==================== CONFIG SYSTEM ====================

const CONFIG_FILE = path.join(__dirname, "config.json");

let config = {
  logChannels: {
    moderation: null,    // Модерация (баны, кики, варны)
    players: null,       // Вход/выход игроков
    server: null,        // Управление серверами
    announcements: null  // Объявления
  },
  serverLock: false,
  activeServers: new Map() // jobId -> { started, playerCount }
};

function saveConfig() {
  const dataToSave = {
    ...config,
    activeServers: Array.from(config.activeServers.entries())
  };
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(dataToSave, null, 2));
}

function loadConfig() {
  if (fs.existsSync(CONFIG_FILE)) {
    const data = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    config = {
      ...data,
      activeServers: new Map(data.activeServers || [])
    };
  }
}

loadConfig();

// ==================== ROBLOX API FUNCTIONS ====================

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
  const body = { 
    gameJoinRestriction: { 
      active: true, 
      privateReason: reason, 
      displayReason: reason, 
      excludeAltAccounts: false, 
      inherited: true 
    } 
  };
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

async function sendMessageToGame(type, data, serverId = null) {
  const message = JSON.stringify({ type, serverId, ...data });
  return await fetch(`https://apis.roblox.com/messaging-service/v1/universes/${UNIVERSE_ID}/topics/Moderation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": OPEN_CLOUD_KEY },
    body: JSON.stringify({ message })
  });
}

async function getActiveServers() {
  try {
    const res = await fetch(`https://games.roblox.com/v1/games/${UNIVERSE_ID}/servers/Public?limit=100`);
    if (!res.ok) return [];
    const data = await res.json();
    return data.data || [];
  } catch (e) {
    console.error("Error fetching servers:", e);
    return [];
  }
}

async function kickRobloxUser(userId, reason) {
  return await sendMessageToGame("kick", { userId, reason });
}

async function announceToGame(message, duration = 10, serverId = null) {
  return await sendMessageToGame("announce", { message, duration }, serverId);
}

async function lockServer(locked) {
  config.serverLock = locked;
  saveConfig();
  return await sendMessageToGame("lockserver", { locked });
}

async function shutdownServer(delay = 30, serverId = null) {
  return await sendMessageToGame("shutdown", { delay }, serverId);
}

async function restartServer(serverId) {
  return await sendMessageToGame("restart", {}, serverId);
}

// ==================== UTILITY FUNCTIONS ====================

function parseDuration(str) {
  if (!str || str === "perm" || str === "permanent") return 0;
  const match = str.match(/^(\d+)(s|m|h|d|w)$/);
  if (!match) return null;
  const val = parseInt(match[1]);
  const unit = match[2];
  const multipliers = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  return val * (multipliers[unit] || 0);
}

function formatDuration(seconds) {
  if (seconds === 0) return "♾️ Permanent";
  const units = [
    { name: "week", sec: 604800 },
    { name: "day", sec: 86400 },
    { name: "hour", sec: 3600 },
    { name: "minute", sec: 60 }
  ];
  for (const unit of units) {
    if (seconds >= unit.sec) {
      const count = Math.floor(seconds / unit.sec);
      return `${count} ${unit.name}${count > 1 ? 's' : ''}`;
    }
  }
  return `${seconds} seconds`;
}

function hasModRole(member) {
  if (!MOD_ROLE_ID) return member.permissions.has(PermissionFlagsBits.BanMembers);
  return member.roles.cache.has(MOD_ROLE_ID) || member.permissions.has(PermissionFlagsBits.Administrator);
}

function hasAdminRole(member) {
  if (!ADMIN_ROLE_ID) return member.permissions.has(PermissionFlagsBits.Administrator);
  return member.roles.cache.has(ADMIN_ROLE_ID) || member.permissions.has(PermissionFlagsBits.Administrator);
}

async function sendLog(type, title, description, color, fields = []) {
  const channelId = config.logChannels[type];
  if (!channelId) return;
  
  const channel = client.channels.cache.get(channelId);
  if (!channel) return;
  
  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(title)
    .setDescription(description)
    .addFields(fields)
    .setTimestamp();
  
  try {
    await channel.send({ embeds: [embed] });
  } catch (e) {
    console.error(`Failed to send log to ${type}:`, e);
  }
}

// ==================== SLASH COMMANDS ====================

const commands = [
  // Moderation Commands
  new SlashCommandBuilder()
    .setName("ban")
    .setDescription("Ban a player in Roblox")
    .addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Ban reason").setRequired(true))
    .addStringOption(o => o.setName("duration").setDescription("Duration: 1d / 12h / 30m / perm").setRequired(false)),
  
  new SlashCommandBuilder()
    .setName("unban")
    .setDescription("Unban a player")
    .addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Unban reason").setRequired(false)),
  
  new SlashCommandBuilder()
    .setName("kick")
    .setDescription("Kick a player from the game")
    .addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Kick reason").setRequired(false)),
  
  new SlashCommandBuilder()
    .setName("warn")
    .setDescription("Warn a player")
    .addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true))
    .addStringOption(o => o.setName("reason").setDescription("Warning reason").setRequired(true)),
  
  new SlashCommandBuilder()
    .setName("warnings")
    .setDescription("View player warnings")
    .addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true)),
  
  new SlashCommandBuilder()
    .setName("clearwarnings")
    .setDescription("Clear all warnings for a player")
    .addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true)),
  
  new SlashCommandBuilder()
    .setName("userinfo")
    .setDescription("Get information about a player")
    .addStringOption(o => o.setName("username").setDescription("Roblox username").setRequired(true)),
  
  // Server Management Commands
  new SlashCommandBuilder()
    .setName("announce")
    .setDescription("Send an announcement to servers")
    .addStringOption(o => o.setName("message").setDescription("Announcement message").setRequired(true))
    .addIntegerOption(o => o.setName("duration").setDescription("Display duration in seconds (default: 10)").setRequired(false))
    .addStringOption(o => o.setName("serverid").setDescription("Specific server ID (leave empty for all)").setRequired(false)),
  
  new SlashCommandBuilder()
    .setName("lockserver")
    .setDescription("Lock/Unlock servers (prevent new players from joining)")
    .addBooleanOption(o => o.setName("locked").setDescription("Lock status (true = locked)").setRequired(true)),
  
  new SlashCommandBuilder()
    .setName("shutdown")
    .setDescription("Shutdown game servers")
    .addIntegerOption(o => o.setName("delay").setDescription("Delay in seconds (default: 30)").setRequired(false))
    .addStringOption(o => o.setName("serverid").setDescription("Specific server ID (leave empty for all)").setRequired(false)),
  
  new SlashCommandBuilder()
    .setName("restart")
    .setDescription("Restart a specific server")
    .addStringOption(o => o.setName("serverid").setDescription("Server ID to restart").setRequired(true))
    .addIntegerOption(o => o.setName("delay").setDescription("Delay in seconds (default: 10)").setRequired(false)),
  
  new SlashCommandBuilder()
    .setName("servers")
    .setDescription("List all active game servers"),
  
  new SlashCommandBuilder()
    .setName("serverstatus")
    .setDescription("Get current server status"),
  
  // Config Commands
  new SlashCommandBuilder()
    .setName("setlogchannel")
    .setDescription("Set log channel for different categories")
    .addStringOption(o => o.setName("type")
      .setDescription("Log type")
      .setRequired(true)
      .addChoices(
        { name: "Moderation (bans, kicks, warns)", value: "moderation" },
        { name: "Players (join/leave)", value: "players" },
        { name: "Server Management", value: "server" },
        { name: "Announcements", value: "announcements" }
      ))
    .addChannelOption(o => o.setName("channel").setDescription("Channel for logs").setRequired(true)),
  
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("View current bot configuration"),
  
  // Utility Commands
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show all available commands"),
  
  new SlashCommandBuilder()
    .setName("modstats")
    .setDescription("View moderation statistics")
    .addUserOption(o => o.setName("moderator").setDescription("Discord moderator (optional)").setRequired(false)),
].map(c => c.toJSON());

// ==================== BOT EVENTS ====================

client.once("ready", async () => {
  console.log(`✅ Bot is ready: ${client.user.tag}`);
  const rest = new REST({ version: "10" }).setToken(TOKEN);
  await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
  console.log("✅ Commands registered successfully!");
  
  client.user.setActivity("Roblox Servers | /help", { type: 3 });
  
  // Update server list every 5 minutes
  setInterval(async () => {
    const servers = await getActiveServers();
    for (const server of servers) {
      if (!config.activeServers.has(server.id)) {
        config.activeServers.set(server.id, {
          started: new Date().toISOString(),
          playerCount: server.playing
        });
      } else {
        config.activeServers.get(server.id).playerCount = server.playing;
      }
    }
    saveConfig();
  }, 300000);
});

// ==================== COMMAND HANDLER ====================

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  
  const cmd = interaction.commandName;
  
  // ==================== HELP COMMAND ====================
  if (cmd === "help") {
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📚 Bot Commands")
      .setDescription("Here are all available commands:")
      .addFields(
        { 
          name: "🛡️ Moderation Commands", 
          value: "`/ban` - Ban a player\n`/unban` - Unban a player\n`/kick` - Kick a player\n`/warn` - Warn a player\n`/warnings` - View warnings\n`/clearwarnings` - Clear warnings\n`/userinfo` - Player information" 
        },
        { 
          name: "🎮 Server Management", 
          value: "`/announce` - Send announcement\n`/lockserver` - Lock/unlock server\n`/shutdown` - Shutdown servers\n`/restart` - Restart specific server\n`/servers` - List active servers\n`/serverstatus` - Server status" 
        },
        { 
          name: "⚙️ Configuration", 
          value: "`/setlogchannel` - Set log channels\n`/config` - View configuration" 
        },
        { 
          name: "📊 Utility", 
          value: "`/help` - Show this menu\n`/modstats` - Moderation statistics" 
        }
      )
      .setFooter({ text: "Duration format: 1d (day), 12h (hours), 30m (minutes), perm (permanent)" })
      .setTimestamp();
    
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  // ==================== CONFIG COMMAND ====================
  if (cmd === "config") {
    if (!hasAdminRole(interaction.member)) {
      return interaction.reply({ content: "❌ You need administrator permissions!", ephemeral: true });
    }
    
    const channels = Object.entries(config.logChannels)
      .map(([type, id]) => {
        const channel = id ? `<#${id}>` : "Not set";
        return `**${type.charAt(0).toUpperCase() + type.slice(1)}:** ${channel}`;
      })
      .join("\n");
    
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("⚙️ Bot Configuration")
      .addFields(
        { name: "📝 Log Channels", value: channels || "No channels set" },
        { name: "🔒 Server Lock", value: config.serverLock ? "🔒 Locked" : "🔓 Unlocked", inline: true },
        { name: "🎮 Tracked Servers", value: `${config.activeServers.size}`, inline: true }
      )
      .setFooter({ text: "Use /setlogchannel to configure log channels" })
      .setTimestamp();
    
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  // ==================== SET LOG CHANNEL COMMAND ====================
  if (cmd === "setlogchannel") {
    if (!hasAdminRole(interaction.member)) {
      return interaction.reply({ content: "❌ You need administrator permissions!", ephemeral: true });
    }
    
    const type = interaction.options.getString("type");
    const channel = interaction.options.getChannel("channel");
    
    if (channel.type !== ChannelType.GuildText) {
      return interaction.reply({ content: "❌ Please select a text channel!", ephemeral: true });
    }
    
    config.logChannels[type] = channel.id;
    saveConfig();
    
    const embed = new EmbedBuilder()
      .setColor(0x44ff88)
      .setTitle("✅ Log Channel Updated")
      .setDescription(`**${type.charAt(0).toUpperCase() + type.slice(1)}** logs will now be sent to ${channel}`)
      .setTimestamp();
    
    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
  
  // Check permissions for mod commands
  const modCommands = ["ban", "unban", "kick", "warn", "warnings", "clearwarnings", "userinfo", "modstats"];
  if (modCommands.includes(cmd) && !hasModRole(interaction.member)) {
    return interaction.reply({ content: "❌ You don't have permission to use this command!", ephemeral: true });
  }
  
  // Check permissions for admin commands
  const adminCommands = ["announce", "lockserver", "shutdown", "restart", "servers"];
  if (adminCommands.includes(cmd) && !hasAdminRole(interaction.member)) {
    return interaction.reply({ content: "❌ You need administrator permissions to use this command!", ephemeral: true });
  }
  
  await interaction.deferReply();
  
  // ==================== BAN COMMAND ====================
  if (cmd === "ban") {
    const username = interaction.options.getString("username");
    const reason   = interaction.options.getString("reason");
    const durStr   = interaction.options.getString("duration") || "perm";
    const duration = parseDuration(durStr);
    
    if (duration === null) {
      return interaction.editReply("❌ Invalid duration format. Examples: 1d, 12h, 30m, perm");
    }
    
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Player **${username}** not found`);
    
    const res = await banRobloxUser(userId, reason, duration);
    
    const embed = new EmbedBuilder()
      .setColor(res.ok ? 0xff4444 : 0x888888)
      .setTitle(res.ok ? "🔨 Player Banned" : "❌ Ban Failed")
      .addFields(
        { name: "Player", value: `${username} (ID: ${userId})`, inline: true },
        { name: "Reason", value: reason, inline: true },
        { name: "Duration", value: formatDuration(duration), inline: true },
        { name: "Moderator", value: interaction.user.tag, inline: true },
        { name: "Status", value: res.ok ? "✅ Success" : `❌ Error ${res.status}`, inline: true }
      )
      .setTimestamp();
    
    if (res.ok) {
      await sendLog("moderation", "🔨 Player Banned", `**${username}** has been banned`, 0xff4444, [
        { name: "Player ID", value: `${userId}`, inline: true },
        { name: "Duration", value: formatDuration(duration), inline: true },
        { name: "Reason", value: reason },
        { name: "Moderator", value: `${interaction.user.tag} (${interaction.user.id})` }
      ]);
    }
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== UNBAN COMMAND ====================
  if (cmd === "unban") {
    const username = interaction.options.getString("username");
    const reason   = interaction.options.getString("reason") || "No reason provided";
    
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Player **${username}** not found`);
    
    const res = await unbanRobloxUser(userId);
    
    const embed = new EmbedBuilder()
      .setColor(res.ok ? 0x44ff88 : 0x888888)
      .setTitle(res.ok ? "✅ Player Unbanned" : "❌ Unban Failed")
      .addFields(
        { name: "Player", value: `${username} (ID: ${userId})`, inline: true },
        { name: "Reason", value: reason, inline: true },
        { name: "Moderator", value: interaction.user.tag, inline: true }
      )
      .setTimestamp();
    
    if (res.ok) {
      await sendLog("moderation", "✅ Player Unbanned", `**${username}** has been unbanned`, 0x44ff88, [
        { name: "Player ID", value: `${userId}`, inline: true },
        { name: "Reason", value: reason },
        { name: "Moderator", value: `${interaction.user.tag} (${interaction.user.id})` }
      ]);
    }
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== KICK COMMAND ====================
  if (cmd === "kick") {
    const username = interaction.options.getString("username");
    const reason   = interaction.options.getString("reason") || "No reason provided";
    
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Player **${username}** not found`);
    
    const res = await kickRobloxUser(userId, reason);
    
    const embed = new EmbedBuilder()
      .setColor(res.ok ? 0xffaa00 : 0x888888)
      .setTitle(res.ok ? "👟 Kick Sent" : "❌ Kick Failed")
      .setDescription(res.ok ? "Signal sent to game. Player will be kicked if online." : "")
      .addFields(
        { name: "Player", value: `${username} (ID: ${userId})`, inline: true },
        { name: "Reason", value: reason, inline: true },
        { name: "Moderator", value: interaction.user.tag, inline: true }
      )
      .setTimestamp();
    
    if (res.ok) {
      await sendLog("moderation", "👟 Player Kicked", `**${username}** has been kicked`, 0xffaa00, [
        { name: "Player ID", value: `${userId}`, inline: true },
        { name: "Reason", value: reason },
        { name: "Moderator", value: `${interaction.user.tag} (${interaction.user.id})` }
      ]);
    }
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== WARN COMMAND ====================
  if (cmd === "warn") {
    const username = interaction.options.getString("username");
    const reason   = interaction.options.getString("reason");
    
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Player **${username}** not found`);
    
    if (!warnings.has(userId)) warnings.set(userId, []);
    const userWarns = warnings.get(userId);
    
    userWarns.push({ 
      reason, 
      moderator: interaction.user.tag, 
      moderatorId: interaction.user.id,
      date: new Date().toISOString()
    });
    
    const embed = new EmbedBuilder()
      .setColor(0xffdd00)
      .setTitle("⚠️ Warning Issued")
      .addFields(
        { name: "Player", value: `${username} (ID: ${userId})`, inline: true },
        { name: "Reason", value: reason, inline: true },
        { name: "Total Warnings", value: `${userWarns.length}`, inline: true },
        { name: "Moderator", value: interaction.user.tag, inline: true }
      )
      .setTimestamp();
    
    await sendLog("moderation", "⚠️ Warning Issued", `**${username}** received a warning`, 0xffdd00, [
      { name: "Player ID", value: `${userId}`, inline: true },
      { name: "Total Warnings", value: `${userWarns.length}`, inline: true },
      { name: "Reason", value: reason },
      { name: "Moderator", value: `${interaction.user.tag} (${interaction.user.id})` }
    ]);
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== WARNINGS COMMAND ====================
  if (cmd === "warnings") {
    const username = interaction.options.getString("username");
    
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Player **${username}** not found`);
    
    const userWarns = warnings.get(userId) || [];
    
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`📋 Warnings: ${username}`)
      .setDescription(
        userWarns.length === 0 
          ? "No warnings ✅" 
          : userWarns.map((w, i) => {
              const date = new Date(w.date).toLocaleString("en-US");
              return `**${i+1}.** ${w.reason}\n👮 ${w.moderator} · 📅 ${date}`;
            }).join("\n\n")
      )
      .setFooter({ text: `Total: ${userWarns.length} warning(s)` })
      .setTimestamp();
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== CLEAR WARNINGS COMMAND ====================
  if (cmd === "clearwarnings") {
    const username = interaction.options.getString("username");
    
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Player **${username}** not found`);
    
    const hadWarnings = warnings.has(userId);
    const count = hadWarnings ? warnings.get(userId).length : 0;
    warnings.delete(userId);
    
    const embed = new EmbedBuilder()
      .setColor(0x44ff88)
      .setTitle("🗑️ Warnings Cleared")
      .setDescription(hadWarnings ? `Cleared ${count} warning(s) for **${username}**` : `**${username}** had no warnings`)
      .addFields(
        { name: "Player", value: `${username} (ID: ${userId})`, inline: true },
        { name: "Moderator", value: interaction.user.tag, inline: true }
      )
      .setTimestamp();
    
    if (hadWarnings) {
      await sendLog("moderation", "🗑️ Warnings Cleared", `Warnings cleared for **${username}**`, 0x44ff88, [
        { name: "Player ID", value: `${userId}`, inline: true },
        { name: "Warnings Cleared", value: `${count}`, inline: true },
        { name: "Moderator", value: `${interaction.user.tag} (${interaction.user.id})` }
      ]);
    }
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== USERINFO COMMAND ====================
  if (cmd === "userinfo") {
    const username = interaction.options.getString("username");
    
    const userId = await getRobloxUserId(username);
    if (!userId) return interaction.editReply(`❌ Player **${username}** not found`);
    
    const info = await getRobloxUserInfo(userId);
    if (!info) return interaction.editReply("❌ Failed to fetch user information");
    
    const userWarns = warnings.get(userId) || [];
    
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`👤 ${info.displayName} (@${info.name})`)
      .setURL(`https://www.roblox.com/users/${userId}/profile`)
      .setThumbnail(`https://www.roblox.com/headshot-thumbnail/image?userId=${userId}&width=150&height=150&format=png`)
      .addFields(
        { name: "🆔 User ID", value: `${userId}`, inline: true },
        { name: "📅 Account Created", value: info.created ? new Date(info.created).toLocaleDateString("en-US") : "Unknown", inline: true },
        { name: "⚠️ Warnings", value: `${userWarns.length}`, inline: true },
        { name: "📝 Description", value: info.description || "No description", inline: false }
      )
      .setTimestamp();
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== ANNOUNCE COMMAND ====================
  if (cmd === "announce") {
    const message  = interaction.options.getString("message");
    const duration = interaction.options.getInteger("duration") || 10;
    const serverId = interaction.options.getString("serverid");
    
    const res = await announceToGame(message, duration, serverId);
    
    const embed = new EmbedBuilder()
      .setColor(res.ok ? 0x5865f2 : 0x888888)
      .setTitle(res.ok ? "📢 Announcement Sent" : "❌ Announcement Failed")
      .addFields(
        { name: "Message", value: message },
        { name: "Duration", value: `${duration} seconds`, inline: true },
        { name: "Target", value: serverId ? `Server: ${serverId}` : "All servers", inline: true },
        { name: "Sender", value: interaction.user.tag, inline: true },
        { name: "Status", value: res.ok ? "✅ Sent" : `❌ Error ${res.status}` }
      )
      .setTimestamp();
    
    if (res.ok) {
      await sendLog("announcements", "📢 Announcement", message, 0x5865f2, [
        { name: "Duration", value: `${duration} seconds`, inline: true },
        { name: "Target", value: serverId || "All servers", inline: true },
        { name: "Sender", value: `${interaction.user.tag} (${interaction.user.id})` }
      ]);
    }
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== LOCK SERVER COMMAND ====================
  if (cmd === "lockserver") {
    const locked = interaction.options.getBoolean("locked");
    
    const res = await lockServer(locked);
    
    const embed = new EmbedBuilder()
      .setColor(res.ok ? (locked ? 0xff4444 : 0x44ff88) : 0x888888)
      .setTitle(res.ok ? (locked ? "🔒 Server Locked" : "🔓 Server Unlocked") : "❌ Command Failed")
      .setDescription(res.ok ? (locked ? "New players cannot join the server" : "Players can now join the server") : "")
      .addFields(
        { name: "Status", value: locked ? "🔒 Locked" : "🔓 Unlocked", inline: true },
        { name: "Administrator", value: interaction.user.tag, inline: true }
      )
      .setTimestamp();
    
    if (res.ok) {
      await sendLog("server", locked ? "🔒 Server Locked" : "🔓 Server Unlocked", 
        locked ? "Server is now locked" : "Server is now unlocked", 
        locked ? 0xff4444 : 0x44ff88, [
        { name: "Administrator", value: `${interaction.user.tag} (${interaction.user.id})` }
      ]);
    }
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== SHUTDOWN COMMAND ====================
  if (cmd === "shutdown") {
    const delay = interaction.options.getInteger("delay") || 30;
    const serverId = interaction.options.getString("serverid");
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId("confirm_shutdown")
          .setLabel("✅ Confirm Shutdown")
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId("cancel_shutdown")
          .setLabel("❌ Cancel")
          .setStyle(ButtonStyle.Secondary)
      );
    
    const embed = new EmbedBuilder()
      .setColor(0xff4444)
      .setTitle("⚠️ Shutdown Confirmation")
      .setDescription(`Are you sure you want to shutdown ${serverId ? `server **${serverId}**` : "**all servers**"}?\n\n**Delay:** ${delay} seconds\n**This action cannot be undone!**`)
      .setTimestamp();
    
    const response = await interaction.editReply({ embeds: [embed], components: [row] });
    
    try {
      const confirmation = await response.awaitMessageComponent({ 
        filter: i => i.user.id === interaction.user.id, 
        time: 30000 
      });
      
      if (confirmation.customId === "confirm_shutdown") {
        const res = await shutdownServer(delay, serverId);
        
        const resultEmbed = new EmbedBuilder()
          .setColor(res.ok ? 0xff4444 : 0x888888)
          .setTitle(res.ok ? "🛑 Server Shutdown Initiated" : "❌ Shutdown Failed")
          .setDescription(res.ok ? `${serverId ? "Server" : "All servers"} will shutdown in ${delay} seconds` : "Failed to send shutdown command")
          .addFields(
            { name: "Target", value: serverId || "All servers", inline: true },
            { name: "Delay", value: `${delay} seconds`, inline: true },
            { name: "Administrator", value: interaction.user.tag, inline: true }
          )
          .setTimestamp();
        
        if (res.ok) {
          await sendLog("server", "🛑 Server Shutdown", `Shutdown initiated with ${delay}s delay`, 0xff4444, [
            { name: "Target", value: serverId || "All servers", inline: true },
            { name: "Delay", value: `${delay} seconds`, inline: true },
            { name: "Administrator", value: `${interaction.user.tag} (${interaction.user.id})` }
          ]);
        }
        
        await confirmation.update({ embeds: [resultEmbed], components: [] });
      } else {
        const cancelEmbed = new EmbedBuilder()
          .setColor(0x888888)
          .setTitle("❌ Shutdown Cancelled")
          .setDescription("Server shutdown has been cancelled")
          .setTimestamp();
        
        await confirmation.update({ embeds: [cancelEmbed], components: [] });
      }
    } catch (e) {
      const timeoutEmbed = new EmbedBuilder()
        .setColor(0x888888)
        .setTitle("⏱️ Confirmation Timeout")
        .setDescription("Shutdown command has been cancelled due to timeout")
        .setTimestamp();
      
      await interaction.editReply({ embeds: [timeoutEmbed], components: [] });
    }
  }
  
  // ==================== RESTART COMMAND ====================
  if (cmd === "restart") {
    const serverId = interaction.options.getString("serverid");
    const delay = interaction.options.getInteger("delay") || 10;
    
    const row = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId("confirm_restart")
          .setLabel("✅ Confirm Restart")
          .setStyle(ButtonStyle.Primary),
        new ButtonBuilder()
          .setCustomId("cancel_restart")
          .setLabel("❌ Cancel")
          .setStyle(ButtonStyle.Secondary)
      );
    
    const embed = new EmbedBuilder()
      .setColor(0xffaa00)
      .setTitle("⚠️ Restart Confirmation")
      .setDescription(`Are you sure you want to restart server **${serverId}**?\n\n**Delay:** ${delay} seconds`)
      .setTimestamp();
    
    const response = await interaction.editReply({ embeds: [embed], components: [row] });
    
    try {
      const confirmation = await response.awaitMessageComponent({ 
        filter: i => i.user.id === interaction.user.id, 
        time: 30000 
      });
      
      if (confirmation.customId === "confirm_restart") {
        // First send shutdown
        const shutdownRes = await shutdownServer(delay, serverId);
        
        const resultEmbed = new EmbedBuilder()
          .setColor(shutdownRes.ok ? 0xffaa00 : 0x888888)
          .setTitle(shutdownRes.ok ? "🔄 Server Restart Initiated" : "❌ Restart Failed")
          .setDescription(shutdownRes.ok ? `Server **${serverId}** will restart in ${delay} seconds\n\nPlayers will be able to rejoin once the server restarts.` : "Failed to send restart command")
          .addFields(
            { name: "Server ID", value: serverId, inline: true },
            { name: "Delay", value: `${delay} seconds`, inline: true },
            { name: "Administrator", value: interaction.user.tag, inline: true }
          )
          .setTimestamp();
        
        if (shutdownRes.ok) {
          await sendLog("server", "🔄 Server Restart", `Server **${serverId}** restart initiated`, 0xffaa00, [
            { name: "Server ID", value: serverId, inline: true },
            { name: "Delay", value: `${delay} seconds`, inline: true },
            { name: "Administrator", value: `${interaction.user.tag} (${interaction.user.id})` }
          ]);
        }
        
        await confirmation.update({ embeds: [resultEmbed], components: [] });
      } else {
        const cancelEmbed = new EmbedBuilder()
          .setColor(0x888888)
          .setTitle("❌ Restart Cancelled")
          .setDescription("Server restart has been cancelled")
          .setTimestamp();
        
        await confirmation.update({ embeds: [cancelEmbed], components: [] });
      }
    } catch (e) {
      const timeoutEmbed = new EmbedBuilder()
        .setColor(0x888888)
        .setTitle("⏱️ Confirmation Timeout")
        .setDescription("Restart command has been cancelled due to timeout")
        .setTimestamp();
      
      await interaction.editReply({ embeds: [timeoutEmbed], components: [] });
    }
  }
  
  // ==================== SERVERS COMMAND ====================
  if (cmd === "servers") {
    const servers = await getActiveServers();
    
    if (servers.length === 0) {
      return interaction.editReply("❌ No active servers found");
    }
    
    const serverList = servers.slice(0, 10).map((s, i) => 
      `**${i+1}.** ID: \`${s.id}\`\n👥 ${s.playing}/${s.maxPlayers} players · 🏓 ${s.ping}ms`
    ).join("\n\n");
    
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle(`🎮 Active Servers (${servers.length})`)
      .setDescription(serverList)
      .setFooter({ text: servers.length > 10 ? `Showing 10 of ${servers.length} servers` : `Total: ${servers.length} servers` })
      .setTimestamp();
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== SERVER STATUS COMMAND ====================
  if (cmd === "serverstatus") {
    const servers = await getActiveServers();
    const totalPlayers = servers.reduce((sum, s) => sum + s.playing, 0);
    const totalCapacity = servers.reduce((sum, s) => sum + s.maxPlayers, 0);
    
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("🎮 Server Status")
      .addFields(
        { name: "🔒 Server Lock", value: config.serverLock ? "🔒 Locked" : "🔓 Unlocked", inline: true },
        { name: "🎮 Active Servers", value: `${servers.length}`, inline: true },
        { name: "👥 Total Players", value: `${totalPlayers} / ${totalCapacity}`, inline: true }
      )
      .setFooter({ text: "Use /servers for detailed server list" })
      .setTimestamp();
    
    return interaction.editReply({ embeds: [embed] });
  }
  
  // ==================== MOD STATS COMMAND ====================
  if (cmd === "modstats") {
    const targetMod = interaction.options.getUser("moderator");
    
    let totalWarnings = 0;
    let modWarnings = 0;
    const moderatorStats = new Map();
    
    for (const [userId, warns] of warnings.entries()) {
      totalWarnings += warns.length;
      for (const warn of warns) {
        const modId = warn.moderatorId || warn.moderator;
        moderatorStats.set(modId, (moderatorStats.get(modId) || 0) + 1);
        if (targetMod && modId === targetMod.id) {
          modWarnings++;
        }
      }
    }
    
    const topMods = Array.from(moderatorStats.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([mod, count], i) => `${i+1}. <@${mod}> - ${count} warnings`)
      .join("\n") || "No data";
    
    const embed = new EmbedBuilder()
      .setColor(0x5865f2)
      .setTitle("📊 Moderation Statistics")
      .addFields(
        { name: "⚠️ Total Warnings", value: `${totalWarnings}`, inline: true },
        { name: "👤 Warned Players", value: `${warnings.size}`, inline: true },
        { name: "👮 Active Moderators", value: `${moderatorStats.size}`, inline: true }
      );
    
    if (targetMod) {
      embed.addFields({ 
        name: `Stats for ${targetMod.tag}`, 
        value: `Warnings issued: ${modWarnings}`, 
        inline: false 
      });
    } else {
      embed.addFields({ 
        name: "🏆 Top Moderators", 
        value: topMods, 
        inline: false 
      });
    }
    
    embed.setTimestamp();
    
    return interaction.editReply({ embeds: [embed] });
  }
});

client.login(TOKEN);

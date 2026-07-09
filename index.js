require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  SlashCommandBuilder,
  REST,
  Routes,
} = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const play = require('play-dl');
const { spawn } = require('child_process');

// Wywołuje yt-dlp i zwraca jego stdout jako tekst (do pobierania tytułu itp.)
function ytDlpGet(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn('yt-dlp', args);
    let out = '';
    let err = '';
    proc.stdout.on('data', (d) => (out += d));
    proc.stderr.on('data', (d) => (err += d));
    proc.on('close', (code) => {
      if (code === 0) resolve(out.trim());
      else reject(new Error(err.trim() || `yt-dlp zakończył się kodem ${code}`));
    });
    proc.on('error', reject);
  });
}

// Zwraca strumień audio (stdout procesu yt-dlp) dla linku YouTube.
// Klient "android" często omija blokady typu "Sign in to confirm you're not a bot".
function ytDlpStream(url) {
  const proc = spawn('yt-dlp', [
    '-f',
    'bestaudio',
    '--no-playlist',
    '--no-warnings',
    '--extractor-args',
    'youtube:player_client=android',
    '-o',
    '-',
    url,
  ]);
  proc.stderr.on('data', (d) => console.error(`[yt-dlp] ${d}`.trim()));
  return proc;
}

const DEFAULT_VOLUME = Number(process.env.DEFAULT_VOLUME || 50);

// Uwaga: brak GatewayIntentBits.MessageContent — komendy slash nie go potrzebują,
// więc nie trzeba włączać żadnych "Privileged Gateway Intents" w Discord Developer Portal.
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// Stan każdego serwera (guild): kolejka, odtwarzacz, głośność itd.
const guildStates = new Map();

function getGuildState(guildId) {
  if (!guildStates.has(guildId)) {
    guildStates.set(guildId, {
      connection: null,
      player: null,
      queue: [],
      volume: DEFAULT_VOLUME / 100,
      playing: null,
      textChannel: null,
    });
  }
  return guildStates.get(guildId);
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Przekroczono limit czasu (${label}, ${ms}ms).`)), ms),
    ),
  ]);
}

async function playNext(guildId) {
  const state = getGuildState(guildId);
  const next = state.queue.shift();

  if (!next) {
    state.playing = null;
    return;
  }

  state.playing = next;
  console.log(`[${guildId}] ▶️ Rozpoczynam stream (${next.source}): ${next.title} (${next.url})`);

  try {
    let resource;

    if (next.source === 'youtube') {
      const proc = ytDlpStream(next.url);
      state.ytdlpProcess = proc;
      resource = createAudioResource(proc.stdout, {
        inputType: StreamType.Arbitrary,
        inlineVolume: true,
      });
    } else {
      const streamInfo = await withTimeout(play.stream(next.url, { quality: 2 }), 15_000, 'play.stream');
      console.log(`[${guildId}] ✅ Stream gotowy, typ: ${streamInfo.type}`);
      resource = createAudioResource(streamInfo.stream, {
        inputType: streamInfo.type,
        inlineVolume: true,
      });
    }

    resource.volume.setVolume(state.volume);
    state.currentResource = resource;
    state.player.play(resource);
    console.log(`[${guildId}] ▶️ Gram: ${next.title}`);

    if (state.textChannel) {
      state.textChannel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(0x5865f2)
            .setTitle('▶️ Teraz gram')
            .setDescription(`**${next.title}**`)
            .setFooter({ text: `Głośność: ${Math.round(state.volume * 100)}%` }),
        ],
      });
    }
  } catch (err) {
    console.error(`[${guildId}] ❌ Błąd odtwarzania:`, err);
    if (state.textChannel) {
      state.textChannel.send(`⚠️ Nie udało się odtworzyć **${next.title}** (${err.message}), przechodzę dalej.`);
    }
    playNext(guildId);
  }
}

function killYtDlp(state) {
  if (state.ytdlpProcess) {
    state.ytdlpProcess.kill('SIGKILL');
    state.ytdlpProcess = null;
  }
}

async function resolveTrack(query) {
  let url = query;
  let title = query;

  const isSoundcloudUrl = query.includes('soundcloud.com');
  const isYoutubeUrl = query.includes('youtube.com') || query.includes('youtu.be');
  console.log(`[resolveTrack] szukam: "${query}", soundcloud=${isSoundcloudUrl}, youtube=${isYoutubeUrl}`);

  let source = 'soundcloud';

  if (isSoundcloudUrl) {
    const info = await withTimeout(play.soundcloud(query), 15_000, 'soundcloud info');
    url = info.url;
    title = info.name;
  } else if (isYoutubeUrl) {
    // Używamy yt-dlp (klient "android") do pobrania tytułu i strumienia —
    // lepiej omija blokady YouTube na serwerach chmurowych niż play-dl.
    source = 'youtube';
    title = await withTimeout(
      ytDlpGet(['--print', '%(title)s', '--skip-download', '--no-warnings', '--extractor-args', 'youtube:player_client=android', query]),
      20_000,
      'yt-dlp title',
    );
    url = query;
  } else {
    // Wyszukiwanie po nazwie — SoundCloud, nie wymaga logowania/ciasteczek.
    const results = await withTimeout(
      play.search(query, { limit: 1, source: { soundcloud: 'tracks' } }),
      15_000,
      'play.search',
    );
    if (!results.length) {
      throw new Error('Nie znaleziono utworu na SoundCloud. Spróbuj innej frazy lub wklej link SoundCloud/YouTube.');
    }
    url = results[0].url;
    title = results[0].name;
  }

  console.log(`[resolveTrack] znaleziono (${source}): "${title}" -> ${url}`);
  return { url, title, source };
}

const commands = [
  new SlashCommandBuilder()
    .setName('play')
    .setDescription('Odtwarza utwór lub dodaje go do kolejki')
    .addStringOption((opt) =>
      opt.setName('utwor').setDescription('Nazwa utworu lub link YouTube').setRequired(true),
    ),
  new SlashCommandBuilder().setName('skip').setDescription('Pomija aktualny utwór'),
  new SlashCommandBuilder().setName('pause').setDescription('Pauzuje odtwarzanie'),
  new SlashCommandBuilder().setName('resume').setDescription('Wznawia odtwarzanie'),
  new SlashCommandBuilder().setName('stop').setDescription('Zatrzymuje i czyści kolejkę'),
  new SlashCommandBuilder()
    .setName('volume')
    .setDescription('Ustawia lub pokazuje głośność')
    .addIntegerOption((opt) =>
      opt.setName('wartosc').setDescription('Głośność 0-100').setMinValue(0).setMaxValue(100).setRequired(false),
    ),
  new SlashCommandBuilder().setName('queue').setDescription('Pokazuje kolejkę utworów'),
  new SlashCommandBuilder().setName('help').setDescription('Wyświetla listę komend'),
].map((c) => c.toJSON());

client.once('ready', async () => {
  console.log(`✅ Zalogowano jako ${client.user.tag}`);

  try {
    const rest = new REST().setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Zarejestrowano komendy slash (może potrwać do 1h propagacja globalna).');
  } catch (err) {
    console.error('❌ Nie udało się zarejestrować komend slash:', err);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  if (!interaction.guild) {
    return interaction.reply({ content: 'Ta komenda działa tylko na serwerze.', ephemeral: true });
  }

  const state = getGuildState(interaction.guild.id);
  state.textChannel = interaction.channel;

  try {
    if (interaction.commandName === 'play') {
      const query = interaction.options.getString('utwor', true);
      const voiceChannel = interaction.member?.voice?.channel;
      console.log(`[${interaction.guild.id}] /play "${query}" od ${interaction.user.tag}`);

      if (!voiceChannel) {
        return interaction.reply({ content: 'Musisz być na kanale głosowym, aby użyć tej komendy.', ephemeral: true });
      }

      await interaction.deferReply();

      const track = await resolveTrack(query);
      console.log(`[${interaction.guild.id}] track rozwiązany: ${track.title}`);

      if (!state.connection) {
        const connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId: interaction.guild.id,
          adapterCreator: interaction.guild.voiceAdapterCreator,
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);

        const player = createAudioPlayer();
        connection.subscribe(player);

        player.on(AudioPlayerStatus.Idle, () => {
          playNext(interaction.guild.id);
        });

        player.on('error', (err) => {
          console.error('Błąd odtwarzacza:', err);
          playNext(interaction.guild.id);
        });

        state.connection = connection;
        state.player = player;
      }

      state.queue.push(track);

      if (!state.playing) {
        await playNext(interaction.guild.id);
        return interaction.editReply(`▶️ Odtwarzam: **${track.title}**`);
      }
      return interaction.editReply(`➕ Dodano do kolejki: **${track.title}**`);
    }

    if (interaction.commandName === 'skip') {
      if (!state.player) return interaction.reply({ content: 'Nic nie gra.', ephemeral: true });
      killYtDlp(state);
      state.player.stop();
      return interaction.reply('⏭️ Pominięto utwór.');
    }

    if (interaction.commandName === 'pause') {
      if (!state.player) return interaction.reply({ content: 'Nic nie gra.', ephemeral: true });
      state.player.pause();
      return interaction.reply('⏸️ Wstrzymano odtwarzanie.');
    }

    if (interaction.commandName === 'resume') {
      if (!state.player) return interaction.reply({ content: 'Nic nie gra.', ephemeral: true });
      state.player.unpause();
      return interaction.reply('▶️ Odtwarzanie wznowione.');
    }

    if (interaction.commandName === 'stop') {
      state.queue = [];
      state.playing = null;
      killYtDlp(state);
      if (state.player) state.player.stop();
      if (state.connection) {
        state.connection.destroy();
        state.connection = null;
      }
      return interaction.reply('⏹️ Zatrzymano i wyczyszczono kolejkę.');
    }

    if (interaction.commandName === 'volume') {
      const value = interaction.options.getInteger('wartosc');
      if (value === null) {
        return interaction.reply(`🔊 Aktualna głośność: **${Math.round(state.volume * 100)}%**`);
      }
      state.volume = value / 100;
      if (state.currentResource) {
        state.currentResource.volume.setVolume(state.volume);
      }
      return interaction.reply(`🔊 Głośność ustawiona na **${value}%**.`);
    }

    if (interaction.commandName === 'queue') {
      if (!state.playing && state.queue.length === 0) {
        return interaction.reply({ content: 'Kolejka jest pusta.', ephemeral: true });
      }
      const lines = [];
      if (state.playing) lines.push(`▶️ **${state.playing.title}** (teraz)`);
      state.queue.forEach((t, i) => lines.push(`${i + 1}. ${t.title}`));
      return interaction.reply(lines.join('\n'));
    }

    if (interaction.commandName === 'help') {
      return interaction.reply({
        content: [
          '**Komendy bota muzycznego:**',
          '`/play utwor:<nazwa/link>` - odtwarza lub dodaje do kolejki',
          '`/skip` - pomija utwór',
          '`/pause` / `/resume` - pauza / wznowienie',
          '`/stop` - zatrzymuje i czyści kolejkę',
          '`/volume wartosc:<0-100>` - ustawia głośność',
          '`/queue` - pokazuje kolejkę',
        ].join('\n'),
        ephemeral: true,
      });
    }
  } catch (err) {
    console.error(err);
    const payload = { content: '⚠️ Wystąpił błąd podczas wykonywania komendy.', ephemeral: true };
    if (interaction.deferred || interaction.replied) {
      interaction.editReply(payload).catch(() => {});
    } else {
      interaction.reply(payload).catch(() => {});
    }
  }
});

if (!process.env.DISCORD_TOKEN) {
  console.error('❌ Brak DISCORD_TOKEN w zmiennych środowiskowych. Ustaw go w pliku .env lub w Railway (Variables).');
  process.exit(1);
}

// Minimalny serwer HTTP na "/" — wymagany przez Railway do healthchecków,
// bot Discord sam w sobie nie potrzebuje portu HTTP.
const http = require('http');
const PORT = process.env.PORT || 3000;
http
  .createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot muzyczny działa ✅');
  })
  .listen(PORT, () => {
    console.log(`🌐 Serwer healthcheck działa na porcie ${PORT} (/)`);
  });

process.on('unhandledRejection', (err) => {
  console.error('❌ Unhandled rejection:', err);
});
process.on('uncaughtException', (err) => {
  console.error('❌ Uncaught exception:', err);
});

async function start() {
  try {
    const soundcloudClientId = await play.getFreeClientID();
    await play.setToken({ soundcloud: { client_id: soundcloudClientId } });
    console.log('✅ Zainicjalizowano SoundCloud client_id.');
  } catch (err) {
    console.error('❌ Nie udało się zainicjalizować SoundCloud client_id:', err);
  }

  client.login(process.env.DISCORD_TOKEN);
}

start();

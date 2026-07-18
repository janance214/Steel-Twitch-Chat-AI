import express from 'express';
import fs from 'fs';
import ws from 'ws';
import expressWs from 'express-ws';
import { OpenAIOperations } from './openai_operations.js';
import { TwitchBot } from './twitch_bot.js';

const requiredEnvironmentVariables = [
    'OPENAI_API_KEY',
    'TWITCH_USER',
    'TWITCH_AUTH',
    'CHANNELS',
];

const missingEnvironmentVariables = requiredEnvironmentVariables.filter(
    key => !process.env[key]?.trim()
);

if (missingEnvironmentVariables.length > 0) {
    console.error(
        `STARTUP_FAILED: Missing required environment variables: ${missingEnvironmentVariables.join(', ')}`
    );
    process.exit(1);
}

const GPT_MODE = (process.env.GPT_MODE || 'CHAT').toUpperCase();
const HISTORY_LENGTH = Number.parseInt(process.env.HISTORY_LENGTH || '5', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY.trim();
const MODEL_NAME = process.env.MODEL_NAME || 'gpt-4.1-mini';
const TWITCH_USER = process.env.TWITCH_USER.trim();
const TWITCH_AUTH = process.env.TWITCH_AUTH.trim().startsWith('oauth:')
    ? process.env.TWITCH_AUTH.trim()
    : `oauth:${process.env.TWITCH_AUTH.trim()}`;
const COMMAND_NAME = process.env.COMMAND_NAME || 'steel,!steel';
const CHANNELS = process.env.CHANNELS;
const SEND_USERNAME = process.env.SEND_USERNAME || 'true';
const ENABLE_TTS = process.env.ENABLE_TTS || 'false';
const ENABLE_CHANNEL_POINTS = process.env.ENABLE_CHANNEL_POINTS || 'false';
const COOLDOWN_DURATION = Number.parseInt(process.env.COOLDOWN_DURATION || '10', 10);
const PORT = Number.parseInt(process.env.PORT || '10000', 10);
const HOST = '0.0.0.0';

const commandNames = COMMAND_NAME
    .split(',')
    .map(command => command.trim().toLowerCase())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);

const channels = CHANNELS
    .split(',')
    .map(channel => channel.trim().replace(/^#/, ''))
    .filter(Boolean);

if (channels.length === 0) {
    console.error('STARTUP_FAILED: CHANNELS must contain at least one Twitch channel.');
    process.exit(1);
}

const maxLength = 399;
let lastResponseTime = 0;
let twitchConnected = false;

const fileContext = fs.readFileSync('./file_context.txt', 'utf8');
const openaiOps = new OpenAIOperations(
    fileContext,
    OPENAI_API_KEY,
    MODEL_NAME,
    HISTORY_LENGTH
);
const bot = new TwitchBot(
    TWITCH_USER,
    TWITCH_AUTH,
    channels,
    OPENAI_API_KEY,
    ENABLE_TTS
);

const app = express();
const expressWsInstance = expressWs(app);

app.set('view engine', 'ejs');
app.use(express.json({ extended: true, limit: '1mb' }));
app.use('/public', express.static('public'));

app.get('/health', (req, res) => {
    const status = twitchConnected ? 200 : 503;
    res.status(status).json({
        status: twitchConnected ? 'ok' : 'degraded',
        twitchConnected,
        twitchUser: TWITCH_USER,
        channels,
        model: MODEL_NAME,
        triggers: commandNames,
    });
});

app.all('/', (req, res) => {
    res.render('pages/index');
});

app.get('/gpt/:text', async (req, res) => {
    try {
        const text = req.params.text;
        const answer = GPT_MODE === 'PROMPT'
            ? await openaiOps.make_openai_call_completion(`${fileContext}\n\nUser: ${text}\nAgent:`)
            : await openaiOps.make_openai_call(text);

        res.send(answer);
    } catch (error) {
        console.error('OPENAI_ROUTE_FAILED:', error);
        res.status(500).send('An error occurred while generating the response.');
    }
});

app.ws('/check-for-updates', socket => {
    socket.on('message', () => {
        // Reserved for the optional TTS browser source.
    });
});

const wss = expressWsInstance.getWss();

function notifyFileChange() {
    wss.clients.forEach(client => {
        if (client.readyState === ws.OPEN) {
            client.send(JSON.stringify({ updated: true }));
        }
    });
}

function extractTrigger(message) {
    const trimmedMessage = message.trim();
    const lowerMessage = trimmedMessage.toLowerCase();

    for (const command of commandNames) {
        if (lowerMessage === command) {
            return { command, text: '' };
        }

        if (lowerMessage.startsWith(`${command} `)) {
            return {
                command,
                text: trimmedMessage.slice(command.length).trim(),
            };
        }
    }

    return null;
}

async function sendResponseInChunks(channel, response) {
    if (response.length <= maxLength) {
        await bot.say(channel, response);
        return;
    }

    const chunks = response.match(new RegExp(`.{1,${maxLength}}`, 'g')) || [];
    for (const chunk of chunks) {
        await bot.say(channel, chunk);
    }
}

bot.onConnected((address, port) => {
    twitchConnected = true;
    console.log(`TWITCH_CONNECTED: ${address}:${port}`);
    console.log(`TWITCH_CHANNELS: ${channels.join(', ')}`);
});

bot.onDisconnected(reason => {
    twitchConnected = false;
    console.error(`TWITCH_DISCONNECTED: ${reason}`);
});

bot.onMessage(async (channel, userstate, message, self) => {
    if (self) return;

    try {
        const currentTime = Date.now();
        const elapsedTime = (currentTime - lastResponseTime) / 1000;

        if (
            ENABLE_CHANNEL_POINTS === 'true' &&
            userstate['msg-id'] === 'highlighted-message'
        ) {
            if (elapsedTime < COOLDOWN_DURATION) {
                await bot.say(
                    channel,
                    `Cooldown active. Please wait ${(COOLDOWN_DURATION - elapsedTime).toFixed(1)} seconds.`
                );
                return;
            }

            lastResponseTime = currentTime;
            const highlightedResponse = await openaiOps.make_openai_call(message);
            await sendResponseInChunks(channel, highlightedResponse);
            return;
        }

        const trigger = extractTrigger(message);
        if (!trigger) return;

        const normalizedText = trigger.text.toLowerCase();
        if (normalizedText === 'ping' || normalizedText === 'status') {
            await bot.say(channel, 'S.T.E.E.L. online.');
            return;
        }

        if (!trigger.text) {
            await bot.say(channel, 'Try: !steel ping or Steel who counters Hulk?');
            return;
        }

        if (elapsedTime < COOLDOWN_DURATION) {
            await bot.say(
                channel,
                `Cooldown active. Please wait ${(COOLDOWN_DURATION - elapsedTime).toFixed(1)} seconds.`
            );
            return;
        }

        lastResponseTime = currentTime;
        const username = userstate.username || userstate['display-name'] || 'viewer';
        const prompt = SEND_USERNAME === 'true'
            ? `Message from user ${username}: ${trigger.text}`
            : trigger.text;

        const response = await openaiOps.make_openai_call(prompt);
        await sendResponseInChunks(channel, response);

        if (ENABLE_TTS === 'true') {
            const ttsAudioUrl = await bot.sayTTS(channel, response, userstate);
            if (ttsAudioUrl) notifyFileChange();
        }
    } catch (error) {
        console.error('MESSAGE_HANDLER_FAILED:', error);
        try {
            await bot.say(channel, 'S.T.E.E.L. encountered an error. Check the service logs.');
        } catch (sendError) {
            console.error('ERROR_MESSAGE_FAILED:', sendError);
        }
    }
});

const server = app.listen(PORT, HOST, () => {
    console.log(`HTTP_READY: http://${HOST}:${PORT}`);
    console.log(`OPENAI_MODEL: ${MODEL_NAME}`);
    console.log(`COMMAND_TRIGGERS: ${commandNames.join(', ')}`);
});

bot.connect()
    .then(() => {
        twitchConnected = true;
        console.log('BOT_READY: Twitch connection established.');
    })
    .catch(error => {
        twitchConnected = false;
        console.error('STARTUP_FAILED: Twitch connection could not be established.');
        console.error(error);
        server.close(() => process.exit(1));
    });

async function shutdown(signal) {
    console.log(`SHUTDOWN_REQUESTED: ${signal}`);

    try {
        await bot.disconnect();
    } catch (error) {
        console.error('TWITCH_DISCONNECT_FAILED:', error);
    }

    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

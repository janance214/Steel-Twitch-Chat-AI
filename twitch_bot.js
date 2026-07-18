import tmi from 'tmi.js';
import OpenAI from 'openai';
import { promises as fsPromises } from 'fs';

export class TwitchBot {
    constructor(botUsername, oauthToken, channels, openaiApiKey, enableTts) {
        this.channels = channels;
        this.client = new tmi.client({
            connection: {
                reconnect: true,
                secure: true,
            },
            identity: {
                username: botUsername,
                password: oauthToken,
            },
            channels: this.channels,
        });
        this.openai = new OpenAI({ apiKey: openaiApiKey });
        this.enableTts = enableTts;
    }

    async connect() {
        return this.client.connect();
    }

    async disconnect() {
        return this.client.disconnect();
    }

    onMessage(callback) {
        this.client.on('message', callback);
    }

    onConnected(callback) {
        this.client.on('connected', callback);
    }

    onDisconnected(callback) {
        this.client.on('disconnected', callback);
    }

    async say(channel, message) {
        return this.client.say(channel, message);
    }

    async sayTTS(channel, text, userstate) {
        if (this.enableTts !== 'true') {
            return null;
        }

        try {
            const mp3 = await this.openai.audio.speech.create({
                model: 'tts-1',
                voice: 'alloy',
                input: text,
            });

            const buffer = Buffer.from(await mp3.arrayBuffer());
            const filePath = './public/file.mp3';
            await fsPromises.writeFile(filePath, buffer);
            return filePath;
        } catch (error) {
            console.error('TTS_FAILED:', error);
            return null;
        }
    }

    async addChannel(channel) {
        if (!this.channels.includes(channel)) {
            this.channels.push(channel);
            return this.client.join(channel);
        }

        return null;
    }

    async whisper(username, message) {
        return this.client.whisper(username, message);
    }

    async ban(channel, username, reason) {
        return this.client.ban(channel, username, reason);
    }

    async unban(channel, username) {
        return this.client.unban(channel, username);
    }

    async clear(channel) {
        return this.client.clear(channel);
    }

    async color(channel, color) {
        return this.client.color(channel, color);
    }

    async commercial(channel, seconds) {
        return this.client.commercial(channel, seconds);
    }
}

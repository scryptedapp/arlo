import type { RTCSessionControl, RTCSignalingSession } from '@scrypted/sdk';

import type { ArloDeviceBase } from './base';
import type { ArloCamera } from './camera';
import { SIPManager, USER_AGENTS } from './client';
import type { ArloDevice, Unsubscribe } from './client';
import type { ArloIntercom } from './intercom';
import type { Logger } from './logging';
import type { ArloProvider } from './provider';

export interface IceServer {
    urls: string[];
    username?: string;
    credential?: string;
}

export class BaseArloSignalingSession {
    logger: Logger;
    provider: ArloProvider;
    arloDevice: ArloDevice;
    scryptedSession?: RTCSignalingSession;
    iceServers: IceServer[] = [];

    constructor(device: ArloDeviceBase) {
        this.logger = device.logger;
        this.provider = device.provider;
        this.arloDevice = device.arloDevice;
    }

    protected cleanSdp(sdp: string): string {
        this.logger.debug('Cleaning SDP.');
        const lines = sdp.split('\n').map(line => line.trim()).filter(line => {
            if (!line.startsWith('a=candidate:'))
                return true;
            if (line.split(':').length - 1 <= 1 && !line.includes('.local'))
                return true;
            this.logger.debug(`Filtered out candidate: ${line}`);
            return false;
        });
        const result = lines.join('\r\n');
        this.logger.debug(`Cleaned SDP result: ${result}`);
        return result;
    }

    protected formatIceServers(servers: any[]): IceServer[] {
        return servers.map(server => {
            const entry: IceServer = { urls: [server.url || `${server.type}:${server.domain}:${server.port}`] };
            if ('username' in server)
                entry.username = server.username;
            if ('credential' in server)
                entry.credential = server.credential;
            return entry;
        });
    }

    protected patchSdp(sdp: string): string {
        const header: string[] = [];
        const sections: string[][] = [];
        for (const line of sdp.split(/\r?\n/)) {
            if (line.startsWith('m='))
                sections.push([line]);
            else if (!sections.length)
                header.push(line);
            else
                sections[sections.length - 1].push(line);
        }
        const patched = sections.map((section, index) => {
            if (!section.some(line => line.startsWith('a=mid:'))) {
                const c = section.findIndex(line => line.startsWith('c='));
                section.splice(c >= 0 ? c + 1 : 1, 0, `a=mid:${index}`);
            }
            if (section[0].split(' ')[1] !== '0') {
                const formats = new Set(section[0].trim().split(/\s+/).slice(3));
                return section.filter(line => {
                    const format = /^a=(?:rtpmap|fmtp|rtcp-fb):(\d+)\b/.exec(line)?.[1];
                    return !format || formats.has(format);
                });
            }
            return [
                section[0],
                ...section.filter(line => line.startsWith('c=')).slice(0, 1),
                ...section.filter(line => line.startsWith('a=mid:')).slice(0, 1),
                'a=inactive',
            ];
        });
        return [header.join('\r\n'), ...patched.map(section => section.join('\r\n'))].join('\r\n') + '\r\n';
    }

    async close(): Promise<void> {
    }
}

export class BaseArloSessionControl implements RTCSessionControl {
    constructor(public arloSession: BaseArloSignalingSession, private onEnd?: () => void) {
    }

    async getRefreshAt(): Promise<void> {
    }

    async extendSession(): Promise<void> {
    }

    async setPlayback(options: { audio: boolean, video: boolean }): Promise<void> {
    }

    async endSession(): Promise<void> {
        try {
            await this.arloSession.close();
        }
        catch (e) {
            this.arloSession.logger.error('Error ending session:', e);
            throw e;
        }
        finally {
            this.onEnd?.();
        }
    }
}

export class ArloCameraWebRTCSignalingSession extends BaseArloSignalingSession {
    arloSip?: SIPManager;
    sipInfo: any;
    onEnded?: (reason: string) => void;

    async delayedInit(): Promise<void> {
        this.logger.debug('Fetching SIP info for camera WebRTC session.');
        this.sipInfo = await this.provider.arlo.getSipInfoV2(this.arloDevice);
        if (!this.sipInfo?.sipCallInfo)
            throw new Error('Arlo did not return SIP details for this camera, so its WebRTC stream cannot start.');
        this.iceServers = this.formatIceServers(this.sipInfo.iceServers.data);
        this.logger.debug(`SIP info and ICE servers set: ${JSON.stringify(this.iceServers)}`);
    }

    async setRemoteDescription(offer: { sdp?: string }): Promise<void> {
        const call = this.sipInfo.sipCallInfo;
        this.arloSip = new SIPManager(this.logger, {
            DeviceID: call.deviceId,
            CallerURI: `sip:${call.id}@${call.domain}:${call.port}`,
            CalleeURI: call.calleeUri,
            Password: call.password,
            UserAgent: 'SIP.js/0.21.1',
            WebsocketURI: `wss://${call.domain}:7443`,
            WebsocketOrigin: 'https://my.arlo.com',
            WebsocketHeaders: { 'User-Agent': USER_AGENTS.firefox },
            SDP: this.cleanSdp(offer.sdp ?? ''),
        }, this.provider);
        this.arloSip.onEnded = reason => this.onEnded?.(reason);
        this.logger.debug('SIPManager initialized for camera session.');
    }

    async createLocalDescription(): Promise<{ sdp: string, type: 'answer' }> {
        this.logger.debug('Creating local description (answer) for camera WebRTC session.');
        const answer = this.cleanSdp(this.patchSdp(await this.arloSip.start()));
        return { sdp: answer, type: 'answer' };
    }

    async close(): Promise<void> {
        const sip = this.arloSip;
        if (!sip)
            return;
        this.arloSip = undefined;
        this.logger.debug('Closing camera WebRTC SIP session.');
        await sip.close();
    }
}

export class ArloCameraWebRTCSessionControl extends BaseArloSessionControl {
    constructor(public arloSession: ArloCameraWebRTCSignalingSession, onEnd?: () => void) {
        super(arloSession, onEnd);
    }

    async setPlayback(options: { audio: boolean, video: boolean }): Promise<void> {
        const arloSip = this.arloSession.arloSip;
        if (!arloSip)
            return;
        try {
            if (options.audio) {
                await arloSip.startTalk();
                this.arloSession.logger.info('Talk started in the video call.');
            }
            else if (arloSip.talking) {
                await arloSip.stopTalk();
                this.arloSession.logger.info('Talk stopped in the video call.');
            }
        }
        catch (e) {
            this.arloSession.logger.error('Error in setPlayback:', e);
            throw e;
        }
    }
}

export class ArloIntercomWebRTCSignalingSession extends BaseArloSignalingSession {
    arloBasestation: ArloDevice;
    sessionId = '';
    answer?: { sdp: string, type: 'answer' };
    closed = false;
    private subscriptions: Unsubscribe[] = [];

    constructor(intercom: ArloIntercom) {
        super(intercom);
        this.arloBasestation = intercom.arloBasestation;
    }

    async delayedInit(): Promise<void> {
        this.logger.debug('Starting push-to-talk session for intercom WebRTC.');
        const pushToTalk = await this.provider.arlo.startPushToTalk(this.arloDevice);
        if (!pushToTalk)
            throw new Error('Arlo did not start a push-to-talk session.');
        const [sessionId, iceServers] = pushToTalk;
        this.sessionId = sessionId;
        this.iceServers = this.formatIceServers(iceServers);
        this.startSdpAnswerSubscription();
        this.startCandidateAnswerSubscription();
        this.logger.debug('Intercom WebRTC session initialized.');
    }

    private startSdpAnswerSubscription(): void {
        this.subscriptions.push(this.provider.arlo.subscribeToPushToTalkEvents(this.arloDevice, 'answerSdp', sdp => {
            this.answer = { sdp: this.patchSdp(sdp), type: 'answer' };
        }));
    }

    private startCandidateAnswerSubscription(): void {
        this.subscriptions.push(this.provider.arlo.subscribeToPushToTalkEvents(this.arloDevice, 'answerCandidate', line => {
            const candidate = String(line ?? '').trim().replace(/^a=/, '');
            if (!candidate)
                return;
            this.scryptedSession?.addIceCandidate({ candidate, sdpMid: '0', sdpMLineIndex: 0 })
                .catch(e => this.logger.error('Error in candidate answer subscription:', e));
        }));
    }

    async setRemoteDescription(offer: { sdp?: string }): Promise<void> {
        await this.provider.arlo.notifyPushToTalkOfferSdp(this.arloBasestation, this.arloDevice, this.sessionId, offer.sdp ?? '');
        this.logger.debug('Remote description set and push-to-talk offer notified.');
    }

    async close(): Promise<void> {
        if (this.closed)
            return;
        this.closed = true;
        this.subscriptions.splice(0).forEach(unsubscribe => unsubscribe());
        this.logger.debug('Intercom WebRTC session closed.');
    }
}

export class ArloIntercomWebRTCSessionControl extends BaseArloSessionControl {
}

export class ArloIntercomSIPSignalingSession extends BaseArloSignalingSession {
    arloSip?: SIPManager;
    sipInfo: any;
    camera: ArloCamera;

    constructor(intercom: ArloIntercom) {
        super(intercom);
        this.camera = intercom.camera;
    }

    async delayedInit(): Promise<void> {
        this.sipInfo = this.camera.streamSipInfo;
        if (!this.sipInfo)
            throw new Error('This intercom talks over SIP, which needs an active cloud RTSP stream from this camera, and none is running.');
        this.iceServers = this.formatIceServers(this.sipInfo.iceServers.data);
        this.logger.debug(`SIP info from the current stream and ICE servers set: ${JSON.stringify(this.iceServers)}`);
    }

    async setRemoteDescription(offer: { sdp?: string }): Promise<void> {
        const call = this.sipInfo.sipCallInfo;
        this.arloSip = new SIPManager(this.logger, {
            DeviceID: this.arloDevice.deviceId,
            CallerURI: `sip:${call.id}@${call.domain}:${call.port}`,
            CalleeURI: call.calleeUri,
            Password: call.password,
            UserAgent: 'SIP.js/0.20.1',
            WebsocketURI: `wss://${call.domain}:7443`,
            WebsocketOrigin: 'https://my.arlo.com',
            WebsocketHeaders: { 'User-Agent': USER_AGENTS.linux },
            SDP: this.cleanSdp(offer.sdp ?? ''),
        }, this.provider);
        this.arloSip.onEnded = reason => this.camera.logger.info(`Talk ended: ${reason}.`);
        this.logger.debug('SIPManager initialized for intercom SIP session.');
    }

    async createLocalDescription(): Promise<{ sdp: string, type: 'answer' }> {
        this.logger.debug('Creating local description (answer) for intercom SIP session.');
        const answer = this.cleanSdp(this.patchSdp(await this.arloSip.start()));
        return { sdp: answer, type: 'answer' };
    }

    async close(): Promise<void> {
        const sip = this.arloSip;
        if (!sip)
            return;
        this.arloSip = undefined;
        this.logger.debug('Closing intercom SIP session.');
        await sip.close();
    }
}

export class ArloIntercomSIPSessionControl extends BaseArloSessionControl {
}

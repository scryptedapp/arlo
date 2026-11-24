import sdk, { RTCAVSignalingSetup, RTCSessionControl, RTCSignalingChannel, RTCSignalingSession, ScryptedDeviceType, ScryptedInterface } from '@scrypted/sdk';

import { ArloDeviceBase } from './base';
import type { ArloCamera } from './camera';
import type { ArloDevice } from './client';
import type { ArloProvider } from './provider';
import { sleep, TimeoutError, withTimeout } from './util';
import {
    ArloIntercomSIPSessionControl,
    ArloIntercomSIPSignalingSession,
    ArloIntercomWebRTCSessionControl,
    ArloIntercomWebRTCSignalingSession,
} from './webrtc_sip';

const ANSWER_TIMEOUT = 10_000;

export class ArloIntercom extends ArloDeviceBase implements RTCSignalingChannel {
    private sessions = new Set<ArloIntercomSIPSignalingSession | ArloIntercomWebRTCSignalingSession>();

    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>,
        provider: ArloProvider, public camera: ArloCamera) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
    }

    async close(): Promise<void> {
        await this.endTalk();
        await super.close();
    }

    async endTalk(): Promise<void> {
        const sessions = [...this.sessions];
        this.sessions.clear();
        for (const session of sessions)
            await session.close().catch(e => this.logger.debug(`Could not close a talk session: ${e}`));
    }

    getApplicableInterfaces(): string[] {
        return [ScryptedInterface.RTCSignalingChannel];
    }

    getDeviceType(): string {
        return ScryptedDeviceType.Speaker;
    }

    private async createOffer(scryptedSession: RTCSignalingSession, setup: RTCAVSignalingSetup, sendIceCandidate?: (candidate: RTCIceCandidateInit) => Promise<void>): Promise<RTCSessionDescriptionInit> {
        try {
            return await withTimeout(scryptedSession.createLocalDescription('offer', setup, sendIceCandidate), 3_000);
        }
        catch (e) {
            if (!(e instanceof TimeoutError))
                throw e;
            this.logger.warn('Timeout waiting for ICE candidates, falling back to ignore trickle.');
            return scryptedSession.createLocalDescription('offer', setup, async () => { });
        }
    }

    async startRTCSignalingSession(scryptedSession: RTCSignalingSession): Promise<RTCSessionControl | undefined> {
        const started = Date.now();
        const sip = this.camera.usesSipPushToTalk;
        const sessionType = sip ? 'SIP' : 'WebRTC';
        this.logger.debug(`Using ${sessionType} for intercom session.`);
        const session = sip ? new ArloIntercomSIPSignalingSession(this) : new ArloIntercomWebRTCSignalingSession(this);
        this.sessions.add(session);
        const onEnd = () => this.sessions.delete(session);
        try {
            await session.delayedInit();
            session.scryptedSession = scryptedSession;
            const setup: RTCAVSignalingSetup = {
                type: 'offer',
                audio: { direction: 'sendrecv' },
                configuration: { iceServers: session.iceServers, iceCandidatePoolSize: 0 },
            };
            if (session instanceof ArloIntercomWebRTCSignalingSession) {
                const offer = await this.createOffer(scryptedSession, setup, async candidate => {
                    try {
                        await this.provider.arlo.notifyPushToTalkOfferCandidate(this.arloBasestation, this.arloDevice, session.sessionId, candidate.candidate ?? '');
                        this.logger.debug(`Sent ICE candidate: ${candidate.candidate}`);
                    }
                    catch (e) {
                        this.logger.error('Error sending ICE candidate:', e);
                    }
                });
                this.logger.debug(`Setting local description with offer: ${offer.sdp}`);
                await session.setRemoteDescription(offer);
                this.logger.debug('Waiting for local description to be set by plugin session.');
                const deadline = Date.now() + ANSWER_TIMEOUT;
                while (!session.answer && !session.closed && Date.now() < deadline)
                    await sleep(100);
                if (!session.answer)
                    throw new Error(session.closed
                        ? 'The intercom session closed before Arlo answered.'
                        : `Arlo did not answer the intercom within ${ANSWER_TIMEOUT / 1000} seconds.`);
                this.logger.debug(`Setting remote description with answer: ${session.answer.sdp}`);
                await scryptedSession.setRemoteDescription(session.answer, setup);
                this.logger.debug('WebRTC signaling session established.');
                this.camera.logger.info(`Talk started over push-to-talk; Arlo answered in ${Date.now() - started} ms.`);
                return new ArloIntercomWebRTCSessionControl(session, onEnd);
            }
            const offer = await this.createOffer(scryptedSession, setup);
            this.logger.debug(`Setting local description with offer: ${offer.sdp}`);
            await session.setRemoteDescription(offer);
            const answer = await session.createLocalDescription();
            this.logger.debug(`Setting remote description with answer: ${answer.sdp}`);
            await scryptedSession.setRemoteDescription(answer, setup);
            this.logger.debug('SIP signaling session established.');
            this.camera.logger.info(`Talk started over SIP; Arlo answered in ${Date.now() - started} ms.`);
            return new ArloIntercomSIPSessionControl(session, onEnd);
        }
        catch (e) {
            onEnd();
            await session.close().catch(() => { });
            this.logger.error(`Failed to start ${sessionType} signaling session:`, e);
            throw e;
        }
    }

    speaker(): any {
        return sdk.systemManager.getDeviceById(this.id);
    }
}

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

export class ArloIntercom extends ArloDeviceBase implements RTCSignalingChannel {
    private activeSignalingSessions = new Set<ArloIntercomSIPSignalingSession | ArloIntercomWebRTCSignalingSession>();

    constructor(nativeId: string, arloDevice: ArloDevice, arloBasestation: ArloDevice, arloProperties: Record<string, any>,
        provider: ArloProvider, public camera: ArloCamera) {
        super(nativeId, arloDevice, arloBasestation, arloProperties, provider);
    }

    async close(): Promise<void> {
        await this.endTalk();
        await super.close();
    }

    async endTalk(): Promise<void> {
        const sessions = [...this.activeSignalingSessions];
        this.activeSignalingSessions.clear();
        for (const session of sessions)
            await session.close().catch(e => this.logger.debug(`Could not close a talk session: ${e}`));
    }

    getApplicableInterfaces(): string[] {
        return [ScryptedInterface.RTCSignalingChannel];
    }

    getDeviceType(): string {
        return ScryptedDeviceType.Speaker;
    }

    async startRTCSignalingSession(scryptedSession: RTCSignalingSession): Promise<RTCSessionControl | undefined> {
        const started = Date.now();
        const sessionType = this.camera.usesSipPushToTalk ? 'SIP' : 'WebRTC';
        this.logger.debug(`Using ${sessionType} for intercom session.`);
        const pluginSession = this.camera.usesSipPushToTalk ? new ArloIntercomSIPSignalingSession(this) : new ArloIntercomWebRTCSignalingSession(this);
        this.activeSignalingSessions.add(pluginSession);
        const onEnd = () => this.activeSignalingSessions.delete(pluginSession);
        try {
            if (this.camera.sipCallReason)
                throw new Error(`The camera is in a SIP video call (${this.camera.sipCallReason}); talk works only inside that call.`);
            await pluginSession.delayedInit();
            pluginSession.scryptedSession = scryptedSession;
            const scryptedSetup: RTCAVSignalingSetup = {
                type: 'offer',
                audio: { direction: 'sendrecv' },
                configuration: { iceServers: pluginSession.iceServers, iceCandidatePoolSize: 0 },
            };
            if (pluginSession instanceof ArloIntercomWebRTCSignalingSession) {
                const sendIceCandidate = async (candidate: RTCIceCandidateInit) => {
                    try {
                        await this.provider.arlo.notifyPushToTalkOfferCandidate(this.arloBasestation, this.arloDevice, pluginSession.sessionId, candidate.candidate ?? '');
                        this.logger.debug(`Sent ICE candidate: ${candidate.candidate}`);
                    }
                    catch (e) {
                        this.logger.error('Error sending ICE candidate:', e);
                    }
                };
                let scryptedOffer: RTCSessionDescriptionInit;
                try {
                    scryptedOffer = await withTimeout(scryptedSession.createLocalDescription('offer', scryptedSetup, sendIceCandidate), 3_000);
                }
                catch (e) {
                    if (!(e instanceof TimeoutError))
                        throw e;
                    this.logger.warn('Timeout waiting for ICE candidates, falling back to ignore trickle.');
                    scryptedOffer = await scryptedSession.createLocalDescription('offer', scryptedSetup, async () => { });
                }
                this.logger.debug(`Setting local description with offer: ${scryptedOffer.sdp}`);
                await pluginSession.setRemoteDescription(scryptedOffer);
                this.logger.debug('Waiting for local description to be set by plugin session.');
                const deadline = Date.now() + 10_000;
                while (!pluginSession.answer && !pluginSession.closed && Date.now() < deadline)
                    await sleep(100);
                if (!pluginSession.answer)
                    throw new Error(pluginSession.closed
                        ? 'The intercom session closed before Arlo answered.'
                        : 'Arlo did not answer the intercom within 10 seconds.');
                this.logger.debug(`Setting remote description with answer: ${pluginSession.answer.sdp}`);
                await scryptedSession.setRemoteDescription(pluginSession.answer, scryptedSetup);
                this.logger.debug('WebRTC signaling session established.');
                this.camera.logger.info(`Talk started over push-to-talk; Arlo answered in ${Date.now() - started} ms.`);
                return new ArloIntercomWebRTCSessionControl(pluginSession, onEnd);
            }
            let scryptedOffer: RTCSessionDescriptionInit;
            try {
                scryptedOffer = await withTimeout(scryptedSession.createLocalDescription('offer', scryptedSetup, undefined), 3_000);
            }
            catch (e) {
                if (!(e instanceof TimeoutError))
                    throw e;
                this.logger.warn('Timeout waiting for ICE candidates, falling back to ignore trickle.');
                scryptedOffer = await scryptedSession.createLocalDescription('offer', scryptedSetup, async () => { });
            }
            this.logger.debug(`Setting local description with offer: ${scryptedOffer.sdp}`);
            await pluginSession.setRemoteDescription(scryptedOffer);
            const pluginAnswer = await pluginSession.createLocalDescription();
            this.logger.debug(`Setting remote description with answer: ${pluginAnswer.sdp}`);
            await scryptedSession.setRemoteDescription(pluginAnswer, scryptedSetup);
            this.logger.debug('SIP signaling session established.');
            this.camera.logger.info(`Talk started over SIP; Arlo answered in ${Date.now() - started} ms.`);
            return new ArloIntercomSIPSessionControl(pluginSession, onEnd);
        }
        catch (e) {
            onEnd();
            await pluginSession.close().catch(() => { });
            this.logger.error(`Failed to start ${sessionType} signaling session:`, e);
            throw e;
        }
    }

    speaker(): any {
        return sdk.systemManager.getDeviceById(this.id);
    }
}

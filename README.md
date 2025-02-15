# Arlo Plugin for Scrypted

## Introduction

The Arlo Plugin connects Scrypted to Arlo Cloud, allowing you to access all of your Arlo cameras in Scrypted.

It is highly recommended to create a dedicated Arlo account for use with this plugin and share your cameras from your main account, as Arlo only permits one active login to their servers per account. Using a separate account allows you to use the Arlo app or website simultaneously with this plugin, otherwise logging in from one place will log you out from all other devices.

The account you use for this plugin must have either SMS or email set as the default 2FA option. Once you enter your username and password on the plugin settings page, you should receive a 2FA code through your default 2FA option. Enter that code into the provided box, and your cameras will appear in Scrypted. Or, see below for configuring IMAP to auto-login with 2FA.

If you experience any trouble logging in, clear the username and password boxes, reload the plugin, and try again.

If you are unable to see shared cameras in your separate Arlo account, ensure that both your primary and secondary accounts are upgraded according to this [forum post](https://web.archive.org/web/20230710141914/https://community.arlo.com/t5/Arlo-Secure/Invited-friend-cannot-see-devices-on-their-dashboard-Arlo-Pro-2/m-p/1889396#M1813). Verify the sharing worked by logging in via the Arlo web dashboard.

**If you add or remove cameras from your main Arlo account, or share/un-share/re-share cameras with the Arlo account used with this plugin, ensure that you reload this plugin to get the updated camera state from Arlo Cloud.**

## General Setup Notes

* Ensure that your Arlo account's default 2FA option is set to either SMS or email.
* Motion events notifications must be turned on in the Arlo app. If you are receiving motion push notifications, Scrypted will also receive motion events. If you are using any downstream plugins (e.g. Homekit), you can disable the Arlo app notifications in your phone's notification settings after they've been enabled inside of the Arlo app. This way, you are not getting double notifications for motion events.
* Disable smart detection and any cloud/local recording in the Arlo app. Arlo Cloud permits one active RTSP/DASH stream, so any smart detection or recording features may prevent downstream plugins (e.g. Homekit) from successfully pulling the video feed after a motion event.
* It is highly recommended to enable the Rebroadcast plugin to allow multiple downstream plugins (e.g. Homekit) to pull the video feed within Scrypted.
* The plugin supports pulling WebRTC, RTSP, or DASH streams from Arlo Cloud. It is recommended to use WebRTC for streaming and RTSP for recording. DASH is inconsistent in reliability, and may return finicky codecs that require additional FFmpeg output arguments, e.g. `-vcodec h264`. *Note that all options will ultimately pull the same video stream feed from your camera, and they cannot be used at the same time due to the single stream limitation. If you have the stream open while Scrypted tries to record, it will not work.*
* If using newer model cameras (e.g. Essential Generation 2) with downstream plugins (e.g. Homekit), the RTSP/DASH streams must be transcoded for streaming and recording. Transcoding can be enabled per camera in the `Extensions` section and you must select transcoding for the streams you are using RTSP/DASH. WebRTC transcoding is not required for streaming, but is required for recording.
* If using WebRTC, it is recommended to leave all settings as `default` in the stream settings. This will allow Scrypted to work the most effeciently as the streams from Arlo Cloud are already compatible with Scrypted and downstream plugins (e.g. Homekit) for streaming. WebRTC has shown to be inconsistent in recordings in downstream plugins (e.g. Homekit) and requires transcoding of the audio, therefore it is recommended to use RTSP for recording when using WebRTC for streaming. It is recommended to set RTSP to `FFmpeg (TCP)` for the parser and leave everything else default. You will set the Local, Remote, and Low Resolution Streams to WebRTC and Local and Remote Recoding Streams to RTSP.
* If using a downstream plugin (e.g. Homekit) and using WebRTC, the recommended RTP Sender in the Homekit plugin is `default`. Even if you are using RTSP to record. If you are only using RTSP/DASH and not using WebRTC at all, the recommended RTP Sender is `FFmpeg`.
* Prebuffering should only be enabled if the camera is wired to a persistent power source, such as a wall outlet, solar panels do not appear to be sufficient. Prebuffering will only work if your camera does not have a battery or `Plugged In to External Power` is selected.

Note that streaming cameras uses extra Internet bandwidth, since video and audio packets will need to travel from the camera through your network, out to Arlo Cloud, and then back to your network and into Scrypted.

## IMAP 2FA

The Arlo Plugin supports using the IMAP protocol to check an email mailbox for Arlo 2FA codes. This requires you to specify an email 2FA option as the default in your Arlo account settings.

The plugin should work with any mailbox that supports IMAP, but so far has been tested with Gmail. To configure a Gmail mailbox, see [here](https://support.google.com/mail/answer/7126229?hl=en) to see the Gmail IMAP settings, and [here](https://support.google.com/accounts/answer/185833?hl=en) to create an App Password. Enter the App Password in place of your normal Gmail password.

The plugin searches for emails sent by Arlo's `do_not_reply@arlo.com` address when looking for 2FA codes. If you are using a service to forward emails to the mailbox registered with this plugin (e.g. a service like iCloud's Hide My Email), it is possible that Arlo's email sender address has been overwritten by the mail forwarder. Check the email registered with this plugin to see what address the mail forwarder uses to replace Arlo's sender address, and update that in the IMAP 2FA settings.

## Virtual Security System for Arlo Sirens

In external integrations like Homekit, sirens are exposed as simple on-off switches. This makes it easy to accidentally hit the switch when using the Home app. The Arlo Plugin creates a "virtual" security system device per siren to allow Scrypted to arm or disarm the siren switch to protect against accidental triggers. This fake security system device will be synced into Homekit as a separate accessory from the camera, with the siren itself merged into the security system accessory.

Note that the virtual security system is NOT tied to your Arlo account at all, and will not make any changes such as switching your device's motion alert armed/disarmed modes. For more information, please see the README on the virtual security system device in Scrypted.

## Security System for Arlo Security Modes

In external integrations like Homekit, the Arlo App Security Modes are exposed as a security system. This allows users to change the security mode, Away, Home, or Standby, of the Arlo App from the Home App or the Scrypted Management Console. These security modes in the Arlo App can be used to determine which cameras send notifications. This can be useful when using automations in the Home App to determine when people arrive and leave and which cameras are sending notifications to record.

For example, have all Arlo Cameras set to Stream & Record in the Home App both Home and Away in the Recording Options. Set up the Away Security Mode in the Arlo App to have all cameras send notifications. Set up the Home Security Mode in the Arlo App to only have the cameras you want to send notifications while you are at home. Set up the Standby Security Mode to have none of the cameras send notifications. Now, you can use Automations in the Home App to change the Security Mode of the Virtual Security System so that the Security Mode in the Arlo App changes and only sends notifications for the cameras you want based on your automations. HKSV Recordings are done based on the notifications so even though you are home according to the Home App and the camera is set to Stream & Record in the Home App, it will only record when Scrypted receives the notification.

Multiple Security Systems are created, one for each location. A location is defined as a User Location, a location created on the account signed into Scrypted, and a Shared Location, a location that is shared from another account to the account signed into Scrypted. Each Location has a name in the Arlo App and this name is passed to Scrypted for identification.

Note that this will not set up or modify settings of the Security Modes in the Arlo App, only change which one is active.

## Video Clips

The Arlo Plugin will show video clips available in Arlo Cloud for cameras with cloud recording enabled. These clips are not downloaded onto your Scrypted server, but rather streamed on-demand. Deleting clips is not available in Scrypted and should be done through the Arlo app or the Arlo web dashboard.

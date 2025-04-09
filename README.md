# Arlo Plugin for Scrypted

## Introduction

The Arlo Plugin connects Scrypted to Arlo Cloud, allowing you to access all of your Arlo cameras in Scrypted.

Arlo no longer limits active logins per account, so you can use the Arlo app, website, and this plugin simultaneously without logging out of any devices. However, be mindful of any potential conflicts or issues that may arise when using the plugin concurrently with other Arlo services.

The account you use for this plugin must have either **SMS** or **email** set as the default 2FA option. Once you enter your username and password on the plugin settings page, you should receive a 2FA code through your default 2FA option. Enter that code into the provided box, and your cameras will appear in Scrypted. Or, see below for configuring IMAP to auto-login with 2FA.

If you experience any trouble logging in, clear the username and password boxes, reload the plugin, and try again.

> **Note:** If you add or remove cameras in your Arlo account, ensure that you reload this plugin to get the updated camera state from Arlo Cloud.

---

## General Setup Notes

- **2FA Requirement:** Ensure that your Arlo account's default 2FA option is set to **either SMS or email**. Without this, you will not be able to log in and use the plugin. The plugin will require you to enter a 2FA code once your credentials are entered. This code is sent to you via your selected method, and you will need to input it into the plugin settings.
  
- **Motion Event Notifications:** Motion event notifications must be enabled in the Arlo app. This is important because when motion is detected, the plugin will receive these events and trigger actions. If you are receiving push notifications directly from Arlo, you can disable these notifications in your phone's settings after enabling them in the Arlo app. This avoids receiving duplicate alerts from both the Arlo app and the Scrypted system.

- **Smart Detection & Recording Settings:** Disable **smart detection** and any cloud or local recording options in the Arlo app. Arlo Cloud limits to a single active RTSP or DASH stream per camera. If recording is enabled, it may conflict with the plugin’s ability to stream video, particularly when motion events trigger. Disabling these features ensures that you can get uninterrupted access to the live feed for downstream services (like Homekit) to access the video stream properly.

- **Rebroadcast Plugin:** It is highly recommended to enable the **Rebroadcast plugin** in Scrypted. This will allow multiple downstream integrations (such as Homekit) to access the video feed from a single camera simultaneously. Without the rebroadcast plugin, only one device or platform can access the video feed at a time.

- **Stream Types:** The plugin supports three types of video streams pulled from Arlo Cloud:
  - **WebRTC**: Recommended for streaming, providing a real-time video feed with minimal latency.
  - **RTSP**: Recommended for recording due to its higher reliability for persistent video storage.
  - **DASH**: Less reliable and may require additional configurations like `-vcodec h264` when used with FFmpeg.

  Note that Arlo’s single-stream limitation means you can only use one of these stream types at a time. If you try to access a camera while the stream is already open, it may prevent recording. Therefore, it is recommended to use the same stream for all streams in Scrypted and the Rebroadcast plugin will handle sending the same stream to multiple places, i.e. streaming while recording.

- **Newer Camera Models (e.g., Arlo Essential Gen 2):** If you are using newer models such as the **Essential Gen 2**, and you are integrating with downstream plugins like Homekit, you may need to transcode the RTSP/DASH streams for use. Enable transcoding in the `Extensions` section and configure it per camera for RTSP or DASH streams. This is not necessary for WebRTC streaming, but it is required for recording RTSP/DASH streams.

- **Downstream Plugin RTP Sender:** The recommended RTP Sender in Homekit or similar plugins is `default`. If you have any issues with recording or streaming, try setting the RTP Sender to `FFmpeg`. The default configuration helps ensure compatibility between Scrypted and downstream services.

- **Prebuffering:** Enable **prebuffering** only if the camera is connected to a constant power source (e.g., wall outlet). Solar panels often do not provide sufficient power for prebuffering to function correctly. This feature is most useful for wired cameras with a steady power supply, and will only work when the camera is plugged into an external power source or does not have a battery.

> **Bandwidth Usage:** Keep in mind that streaming video uses extra bandwidth, as video and audio streams must travel from your camera to Arlo Cloud, and then from Arlo Cloud to your network, before finally reaching Scrypted. This additional round-trip may affect your network speed and performance.

---

## IMAP 2FA

The plugin supports using **IMAP** to automatically retrieve Arlo 2FA codes from email. Your Arlo account must have **email** selected as the default 2FA method.

- Tested with Gmail, but compatible with any IMAP provider.
- See [Gmail IMAP settings](https://support.google.com/mail/answer/7126229?hl=en).
- Generate a Gmail [App Password](https://support.google.com/accounts/answer/185833?hl=en) to use in place of your normal password.

The plugin looks for 2FA codes sent from `do_not_reply@arlo.com`. If you use an email forwarding service (e.g. iCloud Hide My Email), confirm that the sender address is not overwritten, and update the plugin’s IMAP settings accordingly.

---

## Virtual Security System for Arlo Sirens

Sirens in Homekit appear as simple on/off switches, which are easy to accidentally trigger. This plugin creates a **virtual security system device** for each siren to prevent accidental activation.

- The virtual system is synced to Homekit as a separate accessory.
- This is **not tied to actual Arlo Security Modes**—it only protects the siren from accidental activation.
- See the in-plugin README for details on the virtual security system.

---

## Security System for Arlo Security Modes

The plugin exposes Arlo App Security Modes (Away, Home, Standby) as a security system in Scrypted and Homekit. This lets you automate camera notification behavior based on mode.

### Example Automation Flow

1. In the Home app:
   - Set all cameras to "Stream & Record" for both Home and Away.
2. In the Arlo app:
   - Configure the **Away mode** to send notifications from all cameras.
   - Configure the **Home mode** to send notifications from select cameras.
   - Configure **Standby mode** to disable all notifications.
3. Use automations in the Home app to switch the Arlo security mode by controlling the virtual system in Scrypted.

> Scrypted only receives events from Arlo when notifications are enabled for a camera in the selected security mode. HKSV recordings depend on receiving these notifications.

Multiple virtual security systems may be created—one per **location** (user or shared). Each system is labeled according to its location name in the Arlo app.

> Note: The plugin does **not** modify your Arlo mode settings—only switches between existing ones.

---

## Video Clips

The plugin will display video clips from Arlo Cloud for cameras with cloud recording enabled.

- Clips are **streamed on-demand**, not downloaded to your Scrypted server.
- To delete clips, use the Arlo mobile app or web dashboard.
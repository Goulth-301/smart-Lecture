const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onObjectFinalized } = require("firebase-functions/v2/storage");
const admin = require("firebase-admin");
const speech = require("@google-cloud/speech");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const os = require("os");

admin.initializeApp();
const db = admin.firestore();
const speechClient = new speech.SpeechClient();

/**
 * processVideo — callable function
 * Called from the frontend with { videoUrl, title }
 */
exports.processVideo = onCall(
  { timeoutSeconds: 300, memory: "1GiB" },
  async (request) => {

    if (!request.auth) {
      throw new HttpsError("unauthenticated", "You must be logged in.");
    }

    const { videoUrl, title } = request.data;
    const uid = request.auth.uid;

    if (!videoUrl) {
      throw new HttpsError("invalid-argument", "videoUrl is required.");
    }

    // Create transcript doc with status "processing"
    const transcriptRef = await db.collection("transcripts").add({
      uid,
      title: title || "Untitled transcript",
      videoUrl,
      status: "processing",
      transcript: "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    try {
      // Download audio from URL
      const tempFilePath = path.join(os.tmpdir(), `audio_${Date.now()}.mp3`);
      const response = await axios({ url: videoUrl, method: "GET", responseType: "stream" });

      await new Promise((resolve, reject) => {
        const writer = fs.createWriteStream(tempFilePath);
        response.data.pipe(writer);
        writer.on("finish", resolve);
        writer.on("error", reject);
      });

      // Convert to base64
      const audioBytes = fs.readFileSync(tempFilePath).toString("base64");

      // Call Speech-to-Text
      const [speechResponse] = await speechClient.recognize({
        audio: { content: audioBytes },
        config: {
          encoding: "MP3",
          sampleRateHertz: 16000,
          languageCode: "en-US",
          enableAutomaticPunctuation: true,
          model: "video",
        },
      });

      const transcriptText = speechResponse.results
        .map((r) => r.alternatives[0].transcript)
        .join("\n\n");

      fs.unlinkSync(tempFilePath);

      await transcriptRef.update({
        status: "done",
        transcript: transcriptText || "No speech detected.",
      });

      return { success: true, transcriptId: transcriptRef.id };

    } catch (err) {
      console.error("Error:", err);
      await transcriptRef.update({ status: "error" });
      throw new HttpsError("internal", err.message);
    }
  }
);

/**
 * processUploadedVideo — triggered when file is uploaded to Storage
 * Path: uploads/{uid}/{filename}
 */
exports.processUploadedVideo = onObjectFinalized(async (event) => {
  const filePath = event.data.name;
  const parts = filePath.split("/");
  if (parts[0] !== "uploads" || parts.length < 3) return null;

  const uid = parts[1];
  const fileName = parts[2];

  const transcriptRef = await db.collection("transcripts").add({
    uid,
    title: fileName.replace(/\.[^/.]+$/, ""),
    videoUrl: `gs://${event.data.bucket}/${filePath}`,
    status: "processing",
    transcript: "",
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  try {
    const [operation] = await speechClient.longRunningRecognize({
      audio: { uri: `gs://${event.data.bucket}/${filePath}` },
      config: {
        encoding: "MP3",
        sampleRateHertz: 16000,
        languageCode: "en-US",
        enableAutomaticPunctuation: true,
        model: "video",
      },
    });

    const [speechResponse] = await operation.promise();

    const transcriptText = speechResponse.results
      .map((r) => r.alternatives[0].transcript)
      .join("\n\n");

    await transcriptRef.update({
      status: "done",
      transcript: transcriptText || "No speech detected.",
    });

  } catch (err) {
    console.error("Error:", err);
    await transcriptRef.update({ status: "error" });
  }

  return null;
});

import { createApp } from "./app.js";
import { connectMongoDB } from "./config/mongodb.js";
import { env } from "./config/env.js";
import { startScheduler } from "./services/campaignService.js";

async function bootstrap() {
  try {
    // Connect to MongoDB first
    await connectMongoDB();

    const app = createApp();
    startScheduler();

    app.listen(env.port, () => {
      console.log(`Skeduloo backend running on http://localhost:${env.port}`);
    });
  } catch (error) {
    console.error("Failed to start backend", error);
    process.exit(1);
  }
}

bootstrap().catch((error) => {
  console.error("Bootstrap error:", error);
  process.exit(1);
});

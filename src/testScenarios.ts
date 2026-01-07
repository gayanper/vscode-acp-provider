import { AcpClient, AcpPermissionHandler } from "./acpClient";
import {
  createPreprogrammedAcpClient,
  PreprogrammedConfig,
} from "./preprogrammedAcpClient";

export function createTestAcpClientWithScenarios(
  permissionHandler: AcpPermissionHandler,
): AcpClient {
  const config: PreprogrammedConfig = {
    permissionHandler: permissionHandler,
    promptPrograms: [],
    session: {
      sessionId: "test-session-id",
    },
  };

  config.promptPrograms?.push({
    promptText: "tell joke",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_thought_chunk",
            content: {
              type: "text",
              text: "Thinking of a joke...",
            },
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "Why did the scarecrow win an award? Because he was outstanding in his field!",
            },
          },
        },
      ],
    },
  });

  return createPreprogrammedAcpClient(config);
}

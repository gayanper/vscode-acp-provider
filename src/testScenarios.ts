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

  addThinkingOfJoke(config);
  addAskForPermissionAndGetWeather(config);
  addToolCallFailure(config);
  addToolCallSuccess(config);

  return createPreprogrammedAcpClient(config);
}

function addThinkingOfJoke(config: PreprogrammedConfig) {
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
}

function addAskForPermissionAndGetWeather(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "fetch weather",
    permission: {
      title: "Allow access to weather data?",
      rawInput: {
        command: [
          "/bin/sh",
          "-c",
          "curl https://api.weather.com/v3/wx/conditions/current",
        ],
      },
    },
    notifications: {
      permissionAllowed: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "fetch_weather_tool_call_1",
            title: "Fetch Weather Data",
            rawInput: {
              command: [
                "/bin/sh",
                "-c",
                "curl https://api.weather.com/v3/wx/conditions/current",
              ],
            },
            status: "in_progress",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "fetch_weather_tool_call_1",
            content: [
              {
                type: "content",
                content: {
                  text: "72°F, Clear Skies",
                  type: "text",
                },
              },
            ],
            rawOutput: {
              output: "Current temperature is 72°F with clear skies.",
            },
            rawInput: {
              command: [
                "/bin/sh",
                "-c",
                "curl https://api.weather.com/v3/wx/conditions/current",
              ],
            },
            status: "completed",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "The current temperature is 72°F with clear skies.",
            },
          },
        },
      ],
      permissionDenied: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "I was unable to fetch the weather data because permission was denied.",
            },
          },
        },
      ],
    },
  });
}

function addToolCallFailure(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "run python",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "python_tool_call_1",
            title: "Run Python Script",
            rawInput: {
              command: ["python3", "-c", "print('Hello World')"],
            },
            status: "in_progress",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "python_tool_call_1",
            rawOutput: {
              command: ["python3", "-c", "print('Hello World')"],
              formatted_output:
                'Traceback (most recent call last):\n  File "<string>", line 1, in <module>\nSyntaxError: invalid syntax',
            },
            status: "failed",
          },
        },
      ],
    },
  });
}

function addToolCallSuccess(config: PreprogrammedConfig) {
  config.promptPrograms?.push({
    promptText: "run ls",
    notifications: {
      prompt: [
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: "ls_tool_call_1",
            title: "List Directory",
            rawInput: {
              command: ["ls", "-la"],
            },
            status: "in_progress",
          },
        },
        {
          sessionId: "test-session-id",
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: "ls_tool_call_1",
            rawOutput: {
              command: ["ls", "-la"],
              aggregated_output:
                "total 8\ndrwxr-xr-x  3 user  staff   96 Sep 14 10:00 .\ndrwxr-xr-x  5 user  staff  160 Sep 14 09:59 ..\n-rw-r--r 1 user  staff   0 Sep 14 10:00 file.txt",
              formatted_output:
                "total 8\ndrwxr-xr-x  3 user  staff   96 Sep 14 10:00 .\ndrwxr-xr-x  5 user  staff  160 Sep 14 09:59 ..\n-rw-r--r 1 user  staff   0 Sep 14 10:00 file.txt",
            },
            content: [
              {
                type: "content",
                content: {
                  type: "text",
                  text: "total 8\ndrwxr-xr-x  3 user  staff   96 Sep 14 10:00 .\ndrwxr-xr-x  5 user  staff  160 Sep 14 09:59 ..\n-rw-r--r 1 user  staff   0 Sep 14 10:00 file.txt",
                },
              },
            ],
            status: "completed",
          },
        },
      ],
    },
  });
}

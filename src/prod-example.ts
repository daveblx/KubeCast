// Example: Test the /api/servers/:id/exec endpoint
// This script assumes you have a server added in your DB and the API is running locally.

import axios from "axios";

async function testExec(serverId: string) {
  try {
    const res = await axios.post(`http://localhost:3000/api/servers/${serverId}/exec`, {
      command: "uname -a"
    });
    console.log("Exit code:", res.data.code);
    console.log("Output:\n", res.data.output);
    if (res.data.error) {
      console.error("Error:\n", res.data.error);
    }
  } catch (err) {
    console.error("Request failed:", err);
  }
}

// Replace with a real server ID from your DB
const SERVER_ID = "your-server-id-here";

testExec(SERVER_ID);

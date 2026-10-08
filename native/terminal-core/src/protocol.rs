use std::io::{self, Write};

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const FRAME_CONTROL_RESPONSE: u8 = 0x01;
pub const FRAME_TERMINAL_DAMAGE: u8 = 0x05;
pub const FRAME_TERMINAL_LIFECYCLE: u8 = 0x06;

#[derive(Debug, Deserialize)]
pub struct CoreRequest {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
pub struct CoreResponse {
    pub id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl CoreResponse {
    pub fn result(id: u64, result: Value) -> Self {
        Self {
            id: Some(id),
            result: Some(result),
            error: None,
        }
    }

    pub fn error(id: Option<u64>, error: String) -> Self {
        Self {
            id,
            result: None,
            error: Some(error),
        }
    }
}

pub fn write_frame<W: Write>(writer: &mut W, frame_type: u8, payload: &[u8]) -> io::Result<()> {
    let length = u32::try_from(payload.len() + 1)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "frame too large"))?;

    writer.write_all(&length.to_le_bytes())?;
    writer.write_all(&[frame_type])?;
    writer.write_all(payload)?;
    writer.flush()
}

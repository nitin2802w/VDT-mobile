import struct
import zlib
from dataclasses import dataclass
from typing import ClassVar


@dataclass
class Packet:
    symbol_seed: int
    payload: bytes

    HEADER_FORMAT: ClassVar[str] = ">IH"
    HEADER_SIZE: ClassVar[int] = struct.calcsize(">IH")
    CRC_FORMAT: ClassVar[str] = ">I"
    CRC_SIZE: ClassVar[int] = struct.calcsize(">I")

    def serialize(self) -> bytes:
        payload_length = len(self.payload)
        header = struct.pack(self.HEADER_FORMAT, self.symbol_seed, payload_length)
        data = header + self.payload
        crc = zlib.crc32(data) & 0xFFFFFFFF
        return data + struct.pack(self.CRC_FORMAT, crc)

    @classmethod
    def deserialize(cls, data: bytes) -> "Packet":
        min_size = cls.HEADER_SIZE + cls.CRC_SIZE
        if len(data) < min_size:
            raise ValueError(f"Packet too short: {len(data)} bytes")
        main_data = data[:-cls.CRC_SIZE]
        crc_bytes = data[-cls.CRC_SIZE:]
        expected_crc = struct.unpack(cls.CRC_FORMAT, crc_bytes)[0]
        actual_crc = zlib.crc32(main_data) & 0xFFFFFFFF
        if expected_crc != actual_crc:
            raise ValueError(f"CRC mismatch. Expected {expected_crc}, got {actual_crc}")
        header_bytes = main_data[:cls.HEADER_SIZE]
        symbol_seed, payload_length = struct.unpack(cls.HEADER_FORMAT, header_bytes)
        payload = main_data[cls.HEADER_SIZE:]
        if len(payload) != payload_length:
            raise ValueError(f"Payload length mismatch.")
        return cls(symbol_seed=symbol_seed, payload=payload)

    def __eq__(self, other):
        if not isinstance(other, Packet):
            return NotImplemented
        return self.symbol_seed == other.symbol_seed and self.payload == other.payload

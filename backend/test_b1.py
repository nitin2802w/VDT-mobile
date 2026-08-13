from app.core.packet import Packet
from app.core.chunker import chunk_data, reconstruct_data
import os

def test_packet():
    print("Testing packet serialization/deserialization...")
    
    # Normal packet
    p1 = Packet(symbol_seed=12345, payload=b"hello world")
    s1 = p1.serialize()
    d1 = Packet.deserialize(s1)
    assert p1 == d1, "Normal packet failed"
    
    # Zero-length payload
    p2 = Packet(symbol_seed=0, payload=b"")
    s2 = p2.serialize()
    d2 = Packet.deserialize(s2)
    assert p2 == d2, "Zero-length payload failed"
    
    # Max-size seed (uint32 max)
    p3 = Packet(symbol_seed=4294967295, payload=b"X" * 1024)
    s3 = p3.serialize()
    d3 = Packet.deserialize(s3)
    assert p3 == d3, "Large payload/seed failed"

    # Corruption test
    corrupted = bytearray(s1)
    corrupted[2] ^= 0xFF # Flip some bits in header
    try:
        Packet.deserialize(bytes(corrupted))
        assert False, "Should have failed CRC check"
    except ValueError as e:
        pass # Expected
        
    print("Packet tests passed!")

def test_chunker():
    print("Testing chunker...")
    
    # Exact multiple
    data1 = os.urandom(1200)
    blocks1, size1 = chunk_data(data1, 400)
    assert size1 == 1200
    assert len(blocks1) == 3
    assert len(blocks1[-1]) == 400
    assert reconstruct_data(blocks1, size1) == data1, "Exact multiple chunking failed"
    
    # Needing padding
    data2 = os.urandom(1050)
    blocks2, size2 = chunk_data(data2, 400)
    assert size2 == 1050
    assert len(blocks2) == 3
    assert len(blocks2[-1]) == 400
    assert blocks2[-1][250:] == b'\x00' * 150 # Check padding
    assert reconstruct_data(blocks2, size2) == data2, "Padded chunking failed"
    
    # Zero length
    data3 = b""
    blocks3, size3 = chunk_data(data3, 400)
    assert size3 == 0
    assert len(blocks3) == 0
    assert reconstruct_data(blocks3, size3) == data3, "Zero-length chunking failed"

    print("Chunker tests passed!")

if __name__ == "__main__":
    test_packet()
    test_chunker()

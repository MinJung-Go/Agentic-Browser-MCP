"""生成简单的扩展图标"""
import base64
import os

# 简单的蓝色圆形 PNG (16x16)
# 这是一个最小的 PNG 文件，显示蓝色背景
def create_simple_png(size, output_path):
    """创建一个简单的纯色 PNG 图标"""
    from struct import pack
    import zlib
    
    # PNG 签名
    signature = b'\x89PNG\r\n\x1a\n'
    
    # IHDR chunk
    width = size
    height = size
    bit_depth = 8
    color_type = 2  # RGB
    compression = 0
    filter_method = 0
    interlace = 0
    ihdr_data = pack('>IIBBBBB', width, height, bit_depth, color_type, compression, filter_method, interlace)
    ihdr_crc = zlib.crc32(b'IHDR' + ihdr_data) & 0xffffffff
    ihdr_chunk = pack('>I', 13) + b'IHDR' + ihdr_data + pack('>I', ihdr_crc)
    
    # IDAT chunk - 蓝色像素数据
    raw_data = b''
    for y in range(height):
        raw_data += b'\x00'  # filter byte
        for x in range(width):
            # 蓝色 RGB (33, 150, 243)
            raw_data += bytes([33, 150, 243])
    
    compressed = zlib.compress(raw_data, 9)
    idat_crc = zlib.crc32(b'IDAT' + compressed) & 0xffffffff
    idat_chunk = pack('>I', len(compressed)) + b'IDAT' + compressed + pack('>I', idat_crc)
    
    # IEND chunk
    iend_crc = zlib.crc32(b'IEND') & 0xffffffff
    iend_chunk = pack('>I', 0) + b'IEND' + pack('>I', iend_crc)
    
    # 写入文件
    with open(output_path, 'wb') as f:
        f.write(signature + ihdr_chunk + idat_chunk + iend_chunk)
    
    print(f"Created {output_path}")

# 生成各尺寸图标
sizes = [16, 32, 48, 128]
for size in sizes:
    create_simple_png(size, f'icon{size}.png')

print("Icons generated!")

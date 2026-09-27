import base64
from pathlib import Path
import subprocess
import pytest
from video_codec import decode_reference_video
from errors import BridgeError

def test_real_mp4_and_unsupported_rate(tmp_path):
    p=tmp_path/'clip.mp4'
    subprocess.run(['ffmpeg','-v','error','-f','lavfi','-i','color=c=blue:s=64x64:r=24','-frames:v','25','-c:v','libx264','-pix_fmt','yuv420p',str(p)],check=True)
    payload={'model':'MiniMaxAI/MiniMax-H3','video':'data:video/mp4;base64,'+base64.b64encode(p.read_bytes()).decode()}
    result=decode_reference_video(payload)
    assert result[0]==p.read_bytes() and result[1:] == ('video/mp4','mp4')
    with pytest.raises(BridgeError):decode_reference_video({**payload,'video_audio':True})
    with pytest.raises(BridgeError):decode_reference_video({**payload,'model':'MiniMaxAI/MiniMax-H3-Turbo'})
    with pytest.raises(BridgeError):decode_reference_video({**payload,'video':'data:video/mp4;base64,AAAA'})

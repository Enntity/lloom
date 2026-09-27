import json
import pytest
from graphs import build_graph, normalize_video_payload
H3='MiniMaxAI/MiniMax-H3'
def one(graph, kind):return next(v['inputs'] for v in graph.values() if v['class_type']==kind)
def test_h3_reference_edges_prompt_checkpoint_and_endpoint():
    prompt={'description':'A person turns naturally.', 'motion':{'blink':'once'},'dialogue':'hello'}
    p={'model':H3,'prompt':prompt,'image':'data:image/png;base64,eA==','audio':'data:audio/wav;base64,eA==','video':'data:video/mp4;base64,eA==','video_audio':True,'transcript':'Exact words here.'}
    g,_,_=build_graph(H3,p,image_filename='portrait.png',audio_filename='voice.wav',video_filename='motion.mp4',last_image_filename='home.png')
    c=one(g,'MiniMaxH3ReferenceToVideo')
    assert 'ref2va' in one(g,'UNETLoader')['unet_name']
    assert all(k in c for k in ['ref_images.ref_image_1','ref_audios.ref_audio_1','ref_videos.ref_video_1','ref_video_audios.ref_video_audio_1'])
    assert c['ref_videos.ref_video_1'][1]==0
    assert c['ref_video_audios.ref_video_audio_1'][1]==1
    assert c['prompt'].startswith(json.dumps(prompt,ensure_ascii=False,separators=(',',':')))
    assert 'Exact words here.' in c['prompt'] and '<Audio 2>' in c['prompt']
    guide=one(g,'MiniMaxH3AddGuide');assert guide['frame_idx']==-1
    assert one(g,'BasicGuider')['conditioning'][0] in [key for key,n in g.items() if n['class_type']=='MiniMaxH3AddGuide']
    assert one(g,'LoadVideo')['file']=='motion.mp4'
def test_plain_frame_h3_remains_frame_conditioned():
    g,_,_=build_graph(H3,{'prompt':'A calm scene'},image_filename='first.png',last_image_filename='last.png')
    assert one(g,'MiniMaxH3ImageToVideo')['prompt']=='A calm scene'
    assert 'fl2va' in one(g,'UNETLoader')['unet_name']
def test_references_and_ignored_controls_are_rejected():
    for p in [{'guidance_scale':5},{'negative_prompt':'blur'},{'fps':30},{'steps':9},{'ref_image_size':'max'},{'workflow':'frames','audio':'data:audio/wav;base64,eA=='}]:
        with pytest.raises(ValueError):build_graph(H3,{'prompt':'x',**p})
    with pytest.raises(ValueError):build_graph(H3+'-Turbo',{'prompt':'x'},video_filename='motion.mp4')
    with pytest.raises(ValueError):build_graph('Lightricks/LTX-2.5',{'prompt':'x'},video_filename='motion.mp4')
def test_normalization_is_idempotent_and_no_parameter_disappears():
    p={'prompt':{'description':'x'},'transcript':'Speak this.','audio':'data:audio/wav;base64,eA==','frame_rate':24,'first_frame':'data:image/png;base64,eA=='}
    first=normalize_video_payload(H3,p)
    assert normalize_video_payload(H3,first)==first
    assert first['image']==p['first_frame'] and first['fps']==24

def test_explicit_h3_reference_selection_is_not_an_arbitrary_graph():
    g,_,_=build_graph(H3,{'prompt':'<Picture 1> turns.', 'workflow':'reference'},image_filename='portrait.png')
    assert one(g,'MiniMaxH3ReferenceToVideo')['ref_images.ref_image_1']
    with pytest.raises(ValueError):build_graph(H3,{'prompt':'x','workflow':{'nodes':[]}})

def test_ltx_rejects_unconnected_controls():
    for fields in [{'image_strength':0.8},{'voice_reference':1},{'voice_identity':3},{'voice_start':0.2}]:
        with pytest.raises(ValueError):build_graph('Lightricks/LTX-2.5',{'prompt':'x',**fields})

def test_invalid_voice_bounds_are_value_errors_and_endpoint_only_works():
    with pytest.raises(ValueError):
        build_graph('Lightricks/LTX-2.5',{'prompt':'x','voice_start':'bad'},audio_filename='voice.wav')
    g,_,_=build_graph('Lightricks/LTX-2.5',{'prompt':'x'},last_image_filename='home.png')
    assert one(g,'LTXVAddGuide')['frame_idx']==-1

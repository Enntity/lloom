import asyncio
import base64
import io
import sys
import threading
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from server import (
    MAX_IMAGES, ApiError, create_app, decode_images, parse_generation, parse_request,
    run_edit, run_generate,
)
from pipeline import MODEL_ID


def png_bytes(size=(64, 64), mode='RGB', color='blue'):
    out = io.BytesIO(); Image.new(mode, size, color).save(out, format='PNG')
    return out.getvalue()


def data_uri(size=(64, 64), mode='RGB', color='blue'):
    return 'data:image/png;base64,' + base64.b64encode(png_bytes(size, mode, color)).decode()


def _closed(image):
    """True once the decoded PIL image has been closed by the server."""
    return getattr(image, "fp", None) is None or image.getbbox() is None

def payload():
    return {'model': MODEL_ID, 'prompt': 'Make the object red', 'image': data_uri()}


def gen_payload():
    return {'model': MODEL_ID, 'prompt': 'A teapot on a windowsill'}


class Immediate:
    def generate(self, params, image, cancel):
        ref = image[0] if isinstance(image, list) else image
        out = io.BytesIO(); (ref if ref is not None else Image.new('RGB', (32, 32))).save(out, format='PNG'); return out.getvalue()


class ListImmediate:
    """Runner that must accept the ordered-list reference contract."""
    def __init__(self):
        self.calls = []

    def generate(self, params, image, cancel):
        self.calls.append((dict(params), image, cancel))
        if isinstance(image, list):
            for item in image:
                assert item is not None
            resolution = image[0].size
        else:
            resolution = (32, 32)
        out = io.BytesIO(); Image.new('RGB', resolution, 'white').save(out, format='PNG')
        return out.getvalue()


class Recording:
    """Records dispatch args so CPU tests can prove generation passes image=None."""
    def __init__(self):
        self.calls = []

    def generate(self, params, image, cancel):
        self.calls.append((dict(params), image, cancel))
        out = io.BytesIO(); Image.new('RGB', (32, 32), 'white').save(out, format='PNG')
        return out.getvalue()


def test_http_success_and_validation():
    with TestClient(create_app(lambda: Immediate())) as c:
        assert c.get('/health').status_code == 200
        r = c.post('/v1/images/generations', json=payload())
        assert r.status_code == 200
        assert base64.b64decode(r.json()['data'][0]['b64_json']).startswith(b'\x89PNG')
        assert c.post('/v1/images/generations', content='[]').status_code == 400
        assert c.post('/v1/images/generations', content=b'x' * (64 * 1024 * 1024 + 1)).status_code == 413


def test_response_expansion_metadata_and_png_provenance():
    with TestClient(create_app(lambda: Immediate())) as c:
        r = c.post('/v1/images/generations', json={**gen_payload(), 'seed': 7, 'steps': 20,
                                                   'size': '1280x768', 'resolution': 1024})
        assert r.status_code == 200
        body = r.json()
        assert body['seed'] == '7' and body['steps'] == '20'
        assert body['size'] == '1280x768' and body['resolution'] == '1024'
        assert body['quality'] == 'high'
        png = base64.b64decode(body['data'][0]['b64_json'])
        with Image.open(io.BytesIO(png)) as im:
            assert im.text.get('lloom:seed') == '7'
            assert im.text.get('lloom:steps') == '20'
            assert im.text.get('lloom:size') == '1280x768'
            assert im.text.get('lloom:resolution') == '1024'
            assert im.text.get('lloom:quality') == 'high'


def test_fresh_default_seed_is_random_and_explicit_is_exact():
    seen = {parse_generation(gen_payload())['seed'] for _ in range(6)}
    assert len(seen) == 6, 'omitted seed must be fresh per request, not a constant'
    assert all(0 <= s < 2 ** 53 for s in seen)
    assert 42 not in seen or len(seen) == 6  # 42 must not be forced
    for explicit in (0, 42, 123456789, 2 ** 53 - 1):
        assert parse_generation({**gen_payload(), 'seed': explicit})['seed'] == explicit
    with pytest.raises(ApiError):
        parse_generation({**gen_payload(), 'seed': 2 ** 53})
    with pytest.raises(ApiError):
        parse_generation({**gen_payload(), 'seed': -1})


def test_quality_presets_and_explicit_steps_override():
    assert parse_generation(gen_payload())['steps'] == 40
    assert parse_generation(gen_payload())['quality'] == 'high'
    for quality, steps in (('high', 40), ('medium', 25), ('low', 12), ('auto', 40)):
        p = {**gen_payload(), 'quality': quality}
        parsed = parse_generation(p)
        assert parsed['steps'] == steps, quality
        assert parsed['quality'] == ('high' if quality == 'auto' else quality)
    over = parse_generation({**gen_payload(), 'quality': 'low', 'steps': 33})
    assert over['steps'] == 33 and over['quality'] == 'low'
    with pytest.raises(ApiError):
        parse_generation({**gen_payload(), 'quality': 'ultra'})
    with pytest.raises(ApiError):
        parse_generation({**gen_payload(), 'quality': 3})


def test_edit_default_quality_and_steps_and_override():
    params, images = parse_request(payload())
    assert params['steps'] == 40 and params['quality'] == 'high'
    for im in images: im.close()
    params, images = parse_request({**payload(), 'quality': 'low'})
    assert params['steps'] == 12
    for im in images: im.close()
    params, images = parse_request({**payload(), 'quality': 'medium', 'steps': 5})
    assert params['steps'] == 5 and params['quality'] == 'medium'
    for im in images: im.close()


@pytest.mark.parametrize('changes', [
    {'image': 'https://example.com/image.png'}, {'image': '/tmp/image.png'},
    {'image': 'data:image/png;base64,!!!!'}, {'image': None}, {'prompt': ''},
    {'prompt': 'x' * 8193}, {'model': 'unknown'}, {'steps': True}, {'seed': False},
    {'steps': 61}, {'seed': -1}, {'cfg': float('nan')}, {'cfg': 2}, {'resolution': 2048 + 32},
    {'graph': {}}, {'n': 2}, {'response_format': 'url'}, {'quality': 'best'},
])
def test_rejections(changes):
    p = payload(); p.update(changes)
    with pytest.raises(ApiError):
        parse_request(p)


def test_resolution_contract():
    p, imgs = parse_request({**payload(), 'resolution': 256})
    assert p['resolution'] == 256
    for im in imgs: im.close()
    p, imgs = parse_request({**payload(), 'resolution': 2048})
    assert p['resolution'] == 2048
    for im in imgs: im.close()
    for bad in (128, 2049, 1000, True, 1024.0, '1024'):
        with pytest.raises(ApiError):
            parse_request({**payload(), 'resolution': bad})


def test_mime_and_shape_checks():
    p = payload(); p['image'] = p['image'].replace('image/png', 'image/jpeg')
    with pytest.raises(ApiError):
        parse_request(p)
    p['image'] = data_uri((2048, 32))
    with pytest.raises(ApiError):
        parse_request(p)


def test_exif_transpose_and_rgba_preserved():
    # A tall image tagged with orientation 6 (rotate 90 CW) must decode to visual order.
    base = Image.new('RGB', (40, 80), 'green')
    exif = base.getexif(); exif[274] = 6
    out = io.BytesIO(); base.save(out, format='JPEG', exif=exif)
    p = payload(); p['image'] = 'data:image/jpeg;base64,' + base64.b64encode(out.getvalue()).decode()
    params, images = parse_request(p)
    assert images[0].size == (80, 40), images[0].size
    for im in images: im.close()

    rgba = io.BytesIO(); Image.new('RGBA', (64, 64), (0, 0, 255, 128)).save(rgba, format='PNG')
    p = payload(); p['image'] = 'data:image/png;base64,' + base64.b64encode(rgba.getvalue()).decode()
    params, images = parse_request(p)
    assert images[0].mode == 'RGBA'
    for im in images: im.close()


def test_ordered_json_multi_reference():
    images = [data_uri((64, 64), color='red'), data_uri((96, 64), color='green'),
              data_uri((32, 32), color='blue')]
    params, decoded = parse_request({**payload(), 'image': images})
    assert len(decoded) == 3
    assert [im.size for im in decoded] == [(64, 64), (96, 64), (32, 32)]
    # edit aspect ratio follows the FIRST reference
    assert (params['width'], params['height']) == (1024, 1024)
    for im in decoded:
        im.close()
    params, decoded = parse_request({**payload(), 'image': [data_uri((128, 64))]})
    assert (params['width'], params['height']) == (1448, 736) or abs(params['width'] / params['height'] - 2) < 0.05
    for im in decoded:
        im.close()
    with pytest.raises(ApiError):
        parse_request({**payload(), 'image': []})
    with pytest.raises(ApiError):
        decode_images({'image': []})
    with pytest.raises(ApiError):
        parse_request({**payload(), 'image': [data_uri()] * (MAX_IMAGES + 1)})


def test_multi_reference_parse_failure_closes_all(monkeypatch):
    import server
    from unittest.mock import Mock
    decoded = Mock()
    calls = 0
    def decode(value):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise ApiError("Invalid image")
        return decoded
    monkeypatch.setattr(server, "_decode_data_uri", decode)
    with pytest.raises(ApiError):
        decode_images({'image': ['first', 'invalid']})
    decoded.close.assert_called_once()


def test_empty_attention_setting_is_invalid():
    from pipeline import attention_mode
    assert attention_mode({}) == "sdpa"
    with pytest.raises(RuntimeError):
        attention_mode({"LLOOM_QWEN_ATTENTION": ""})


class Request:
    disconnected = False

    async def is_disconnected(self):
        return self.disconnected


@pytest.mark.parametrize('cancel_http_task', [False, True])
def test_cancel_keeps_slot_until_worker_exits(cancel_http_task):
    async def scenario():
        started, exit_allowed, cancel_seen = threading.Event(), threading.Event(), threading.Event()

        class Blocking:
            def generate(self, params, image, cancel):
                started.set()
                assert cancel.wait(3)
                cancel_seen.set()
                assert exit_allowed.wait(3)
                return b'ignored'

        app = create_app(lambda: Blocking()); app.state.runner = Blocking()
        req = Request(); params, images = parse_request(payload())
        task = asyncio.create_task(run_edit(app, req, params, images))
        assert await asyncio.to_thread(started.wait, 2)
        if cancel_http_task:
            task.cancel()
        else:
            req.disconnected = True
        assert await asyncio.to_thread(cancel_seen.wait, 2)
        assert app.state.lock.locked() and not task.done()
        p, i = parse_request(payload())
        with pytest.raises(ApiError) as e:
            await run_edit(app, Request(), p, i)
        assert e.value.status == 429
        # A busy rejection must still close the rejected images.
        assert all(_closed(im) for im in i)
        if cancel_http_task:
            task.cancel()
        await asyncio.sleep(.02)
        assert app.state.lock.locked()
        exit_allowed.set()
        with pytest.raises((ApiError, asyncio.CancelledError)):
            await task
        assert not app.state.lock.locked()
        assert all(_closed(im) for im in images)
        app.state.runner = Immediate(); p, i = parse_request(payload())
        assert (await run_edit(app, Request(), p, i)).startswith(b'\x89PNG')
        assert all(_closed(im) for im in i)

    asyncio.run(scenario())


@pytest.mark.parametrize('field,mime', [('image', 'image/png'), ('image[]', 'application/octet-stream')])
def test_multipart_edit(field, mime):
    data = png_bytes()
    p = {'model': MODEL_ID, 'prompt': 'Make it red', 'steps': '40', 'seed': '42', 'cfg': '1', 'n': '1'}
    with TestClient(create_app(lambda: Immediate())) as c:
        r = c.post('/v1/images/edits', data=p, files={field: ('input.png', data, mime)})
        assert r.status_code == 200, r.text
        assert base64.b64decode(r.json()['data'][0]['b64_json']).startswith(b'\x89PNG')
        assert r.json()['seed'] == '42'
        assert isinstance(c.get('/v1/models').json()['data'][0]['created'], int)


def _post_edits(client, fields, files):
    return client.post('/v1/images/edits', data=fields, files=files)


def test_multipart_multi_image_order_preserved():
    runner = ListImmediate()
    data = png_bytes()
    with TestClient(create_app(lambda: runner)) as c:
        files = [
            ('image[]', ('a.png', data, 'image/png')),
            ('image', ('b.png', png_bytes((96, 64)), 'image/png')),
            ('image[]', ('c.png', png_bytes((32, 32)), 'image/png')),
        ]
        r = _post_edits(c, {'model': MODEL_ID, 'prompt': 'combine', 'seed': '5'}, files)
        assert r.status_code == 200, r.text
        params, image, _ = runner.calls[-1]
        assert isinstance(image, list) and len(image) == 3
        assert [im.size for im in image] == [(64, 64), (96, 64), (32, 32)]
        # The server closes every reference once the worker returns.
        assert all(_closed(im) for im in image), 'server must close references after dispatch'


def test_multipart_rejections():
    data = png_bytes()
    good = ('image', ('input.png', data, 'image/png'))
    p = {'model': MODEL_ID, 'prompt': 'edit'}
    with TestClient(create_app(lambda: Immediate())) as c:
        for files, changes in [
            ([], {}), ([], {'size': 'notasize'}),
            ([('mask', ('mask.png', data, 'image/png'))], {}),
            ([('image', ('input.png', data, 'image/jpeg'))], {}),
            ([(good[0], good[1])], {'steps': 'true'}), ([(good[0], good[1])], {'cfg': 'nan'}),
            ([('image', ('input.png', b'x' * (8 * 1024 * 1024 + 1), 'image/png'))], {}),
            ([('image', ('input.png', b'x' * (64 * 1024 * 1024 + 1), 'image/png'))], {}),
            ([good, ('image', ('x.png', data, 'image/png'))], {'extra': 'nope'}),
            ([good, ('image', ('x.png', data, 'image/png'))], {'size': '1000x1000'}),
            ([('image%d' % i, ('r%d.png' % i, data, 'image/png')) for i in range(11)], {}),
        ]:
            r = _post_edits(c, {**p, **changes}, files)
            assert r.status_code in (400, 413), r.text
        assert c.post('/v1/images/edits', data=p).status_code == 400


def test_multipart_duplicate_scalar_rejected():
    data = png_bytes()
    with TestClient(create_app(lambda: Immediate())) as c:
        r = _post_edits(c, [('model', MODEL_ID), ('model', MODEL_ID), ('prompt', 'x'),
                            ('image', ('in.png', data, 'image/png'))], [])
        assert r.status_code == 400


def test_multipart_too_many_images():
    data = png_bytes()
    files = [('image[]', (f'{n}.png', data, 'image/png')) for n in range(MAX_IMAGES + 1)]
    with TestClient(create_app(lambda: Immediate())) as c:
        r = _post_edits(c, {'model': MODEL_ID, 'prompt': 'x'}, files)
        assert r.status_code == 400


def test_no_reference_generation_dispatch_and_defaults():
    runner = Recording()
    with TestClient(create_app(lambda: runner)) as c:
        r = c.post('/v1/images/generations', json=gen_payload())
        assert r.status_code == 200, r.text
        assert base64.b64decode(r.json()['data'][0]['b64_json']).startswith(b'\x89PNG')
        params, image, cancel = runner.calls[-1]
        assert image is None
        assert params['prompt'] == 'A teapot on a windowsill'
        assert params['steps'] == 40 and params['width'] == 1024 and params['height'] == 1024
        assert params['resolution'] == 1024 and params['quality'] == 'high'
        assert 0 <= params['seed'] < 2 ** 53 and params['seed'] != 42
        assert not cancel.is_set()
        caps = c.get('/v1/models').json()['data'][0]['capabilities']
        assert caps == ['image-generation', 'image-editing']


@pytest.mark.parametrize('size,expected', [
    (None, (1024, 1024)), ('1024x1024', (1024, 1024)), ('512x768', (512, 768)),
    ('2048x256', (2048, 256)), ('256x2048', (256, 2048)), ('1920x1024', (1920, 1024)),
    ('2048x1024', (2048, 1024)), ('3072x1024', (3072, 1024)), ('1024x3072', (1024, 3072)),
    ('1536x3072', (1536, 3072)),
])
def test_generation_size_accepted(size, expected):
    p = gen_payload()
    if size is not None:
        p['size'] = size
    params = parse_generation(p)
    assert (params['width'], params['height']) == expected
    assert params['width'] * params['height'] <= int(4.5 * 1024 * 1024)


@pytest.mark.parametrize('size', [
    '1024', '1024x', 'x1024', '1024X1024', ' 1024x1024 ', '1024x1024x1',
    '255x256', '256x255', '1000x1000', '256x64', '4096x512', '3072x2048',
    '0x1024', '-1024x1024', '1024.0x1024', '', '9' * 5000 + 'x1024',
    True, 1024, ['1024x1024'], {'w': 1024},
])
def test_generation_size_rejected(size):
    p = gen_payload(); p['size'] = size
    with pytest.raises(ApiError) as e:
        parse_generation(p)
    assert e.value.status == 400


def test_explicit_size_reaches_model_unchanged():
    runner = Recording()
    with TestClient(create_app(lambda: runner)) as c:
        r = c.post('/v1/images/generations', json={**gen_payload(), 'size': '1536x3072'})
        assert r.status_code == 200, r.text
        params = runner.calls[-1][0]
        assert (params['width'], params['height']) == (1536, 3072)


@pytest.mark.parametrize('steps', [1, 25, 40, 60])
def test_generation_steps_bounds(steps):
    p = gen_payload(); p['steps'] = steps
    assert parse_generation(p)['steps'] == steps


@pytest.mark.parametrize('steps', [0, 61, -1, True, 2.5, '25', None])
def test_generation_steps_rejected(steps):
    p = gen_payload(); p['steps'] = steps
    with pytest.raises(ApiError):
        parse_generation(p)


def test_generation_rejects_edit_only_and_inline_image():
    for changes in ({'image': 'data:image/png;base64,AAAA'}, {'image': None},
                    {'cfg': 2}, {'n': 2}, {'response_format': 'url'},
                    {'graph': {}}, {'steps': 61}, {'seed': -1}, {'prompt': ''}, {'model': 'unknown'}):
        p = gen_payload(); p.update(changes)
        with pytest.raises(ApiError):
            parse_generation(p)


def test_edit_contract_rejects_bad_size_and_steps():
    for changes in ({'size': '1024'}, {'size': 'notasize'}, {'size': '1024x1024x1'}, {'size': 1024}):
        p = payload(); p.update(changes)
        with pytest.raises(ApiError) as e:
            parse_request(p)
        assert e.value.status == 400
    params, images = parse_request(payload())
    assert images[0].size == (64, 64)
    for im in images: im.close()
    p = payload(); p['steps'] = 1
    assert parse_request(p)[0]['steps'] == 1
    p = payload(); p['steps'] = 60
    assert parse_request(p)[0]['steps'] == 60
    for steps in (0, 61, True):
        p = payload(); p['steps'] = steps
        with pytest.raises(ApiError):
            parse_request(p)


def test_edit_explicit_size_reaches_model():
    runner = ListImmediate()
    with TestClient(create_app(lambda: runner)) as c:
        r = c.post('/v1/images/generations', json={**payload(), 'size': '1280x768'})
        assert r.status_code == 200, r.text
        params = runner.calls[-1][0]
        assert (params['width'], params['height']) == (1280, 768)


def test_generation_missing_image_is_not_an_edit():
    for body in (gen_payload(), {**gen_payload(), 'size': '512x512'}):
        params = parse_generation(body)
        assert 'image' not in params
    with pytest.raises(ApiError):
        parse_generation({**gen_payload(), 'image': 'data:image/png;base64,AAAA'})


@pytest.mark.parametrize('cancel_http_task', [False, True])
def test_generation_cancel_keeps_slot_until_worker_exits(cancel_http_task):
    async def scenario():
        started, exit_allowed, cancel_seen = threading.Event(), threading.Event(), threading.Event()
        seen = {}

        class Blocking:
            def generate(self, params, image, cancel):
                seen['image'] = image
                started.set()
                assert cancel.wait(3)
                cancel_seen.set()
                assert exit_allowed.wait(3)
                return b'ignored'

        app = create_app(lambda: Blocking()); app.state.runner = Blocking()
        req = Request(); params = parse_generation(gen_payload())
        task = asyncio.create_task(run_generate(app, req, params, None))
        assert await asyncio.to_thread(started.wait, 2)
        assert seen['image'] is None
        if cancel_http_task:
            task.cancel()
        else:
            req.disconnected = True
        assert await asyncio.to_thread(cancel_seen.wait, 2)
        assert app.state.lock.locked() and not task.done()
        with pytest.raises(ApiError) as e:
            await run_generate(app, Request(), parse_generation(gen_payload()), None)
        assert e.value.status == 429
        if cancel_http_task:
            task.cancel()
        await asyncio.sleep(.02)
        assert app.state.lock.locked()
        exit_allowed.set()
        with pytest.raises((ApiError, asyncio.CancelledError)):
            await task
        assert not app.state.lock.locked()
        app.state.runner = Immediate()
        assert not (await run_generate(app, Request(), parse_generation(gen_payload()), None)).startswith(b'ignored')

    asyncio.run(scenario())

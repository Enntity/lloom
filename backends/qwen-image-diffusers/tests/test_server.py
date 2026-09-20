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
from server import ApiError, create_app, parse_request, run_edit
from pipeline import MODEL_ID


def payload():
    out=io.BytesIO();Image.new('RGB',(64,64),'blue').save(out,format='PNG')
    return {'model':MODEL_ID,'prompt':'Make the object red','image':'data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()}


class Immediate:
    def generate(self, params, image, cancel):
        out=io.BytesIO();image.save(out,format='PNG');return out.getvalue()


def test_http_success_and_validation():
    with TestClient(create_app(lambda:Immediate())) as c:
        assert c.get('/health').status_code==200
        r=c.post('/v1/images/generations',json=payload())
        assert r.status_code==200
        assert base64.b64decode(r.json()['data'][0]['b64_json']).startswith(b'\x89PNG')
        assert c.post('/v1/images/generations',content='[]').status_code==400
        assert c.post('/v1/images/generations',content=b'x'*(16*1024*1024+1)).status_code==413


@pytest.mark.parametrize('changes',[
    {'image':'https://example.com/image.png'}, {'image':'/tmp/image.png'},
    {'image':'data:image/png;base64,!!!!'}, {'image':None}, {'prompt':''},
    {'prompt':'x'*8193}, {'model':'unknown'}, {'steps':True}, {'seed':False},
    {'steps':61}, {'seed':-1}, {'cfg':float('nan')}, {'cfg':2}, {'resolution':2048},
    {'size':'1024x1024'}, {'graph':{}}, {'n':2}, {'response_format':'url'},
])
def test_rejections(changes):
    p=payload();p.update(changes)
    with pytest.raises(ApiError):parse_request(p)


def test_mime_and_shape_checks():
    p=payload();p['image']=p['image'].replace('image/png','image/jpeg')
    with pytest.raises(ApiError):parse_request(p)
    out=io.BytesIO();Image.new('RGB',(2048,32)).save(out,format='PNG')
    p['image']='data:image/png;base64,'+base64.b64encode(out.getvalue()).decode()
    with pytest.raises(ApiError):parse_request(p)


class Request:
    disconnected=False
    async def is_disconnected(self):return self.disconnected


@pytest.mark.parametrize('cancel_http_task',[False,True])
def test_cancel_keeps_slot_until_worker_exits(cancel_http_task):
    async def scenario():
        started,exit_allowed,cancel_seen=threading.Event(),threading.Event(),threading.Event()
        class Blocking:
            def generate(self, params, image, cancel):
                started.set()
                assert cancel.wait(3)
                cancel_seen.set()
                assert exit_allowed.wait(3)
                return b'ignored'
        app=create_app(lambda:Blocking());app.state.runner=Blocking()
        req=Request();params,image=parse_request(payload())
        task=asyncio.create_task(run_edit(app,req,params,image))
        assert await asyncio.to_thread(started.wait,2)
        if cancel_http_task:task.cancel()
        else:req.disconnected=True
        assert await asyncio.to_thread(cancel_seen.wait,2)
        assert app.state.lock.locked() and not task.done()
        p,i=parse_request(payload())
        with pytest.raises(ApiError) as e:await run_edit(app,Request(),p,i)
        assert e.value.status==429
        # A second task cancellation must not abandon a running worker.
        if cancel_http_task:task.cancel()
        await asyncio.sleep(.02)
        assert app.state.lock.locked()
        exit_allowed.set()
        with pytest.raises((ApiError,asyncio.CancelledError)):await task
        assert not app.state.lock.locked()
        app.state.runner=Immediate();p,i=parse_request(payload())
        assert (await run_edit(app,Request(),p,i)).startswith(b'\x89PNG')
    asyncio.run(scenario())


@pytest.mark.parametrize('field,mime', [('image','image/png'), ('image[]','application/octet-stream')])
def test_multipart_edit(field, mime):
    p=payload();data=base64.b64decode(p.pop('image').split(',')[1])
    p.update(steps='40',seed='42',cfg='1',n='1')
    with TestClient(create_app(lambda:Immediate())) as c:
        r=c.post('/v1/images/edits',data=p,files={field:('input.png',data,mime)})
        assert r.status_code==200, r.text
        assert base64.b64decode(r.json()['data'][0]['b64_json']).startswith(b'\x89PNG')
        assert isinstance(c.get('/v1/models').json()['data'][0]['created'],int)


def test_multipart_rejections():
    p=payload();data=base64.b64decode(p.pop('image').split(',')[1])
    good=('image',('input.png',data,'image/png'))
    with TestClient(create_app(lambda:Immediate())) as c:
        for files,changes in [
            ([good,good],{}), ([good,('mask',('mask.png',data,'image/png'))],{}),
            ([('image',('input.png',data,'image/jpeg'))],{}),
            ([good],{'steps':'true'}), ([good],{'cfg':'nan'}), ([good],{'size':'1024x1024'}),
            ([('image',('input.png',b'x'*(8*1024*1024+1),'image/png'))],{}),
            ([('image',('input.png',b'x'*(16*1024*1024+1),'image/png'))],{}),
        ]:
            r=c.post('/v1/images/edits',data={**p,**changes},files=files)
            assert r.status_code in (400,413),r.text
        assert c.post('/v1/images/edits',data=p).status_code==400

lucide.createIcons();

/* ======================================
   HARDWARE BASED PEER ID
====================================== */

async function generateHardwareFingerprint(){

    const fingerprintData = [

        navigator.userAgent,
        navigator.platform,
        navigator.language,
        screen.width,
        screen.height,
        navigator.hardwareConcurrency || '',
        navigator.deviceMemory || ''

    ].join('|');

    const encoder =
        new TextEncoder();

    const data =
        encoder.encode(fingerprintData);

    const hashBuffer =
        await crypto.subtle.digest(
            'SHA-256',
            data
        );

    const hashArray =
        Array.from(
            new Uint8Array(hashBuffer)
        );

    const hashHex =
        hashArray
        .map(b=>b.toString(16).padStart(2,'0'))
        .join('');

    return hashHex.substring(0,5);
}

/* ======================================
   GLOBAL VARIABLES
====================================== */

let peer;
let fixedPeerId;
let securityPin;

const connections = {};
const incoming = {};

/* ======================================
   INIT
====================================== */

initialize();

async function initialize(){

    fixedPeerId =
        localStorage.getItem(
            'globalshare_peerid'
        );

    if(!fixedPeerId){

        fixedPeerId =
            await generateHardwareFingerprint();

        localStorage.setItem(
            'globalshare_peerid',
            fixedPeerId
        );
    }

    securityPin =
        localStorage.getItem(
            'globalshare_pin'
        );

    if(!securityPin){

        securityPin =
            Math.floor(
                1000 + Math.random() * 9000
            ).toString();

        localStorage.setItem(
            'globalshare_pin',
            securityPin
        );
    }

    document.getElementById(
        'peer-id-display'
    ).innerText = fixedPeerId;

    document.getElementById(
        'pin-display'
    ).innerText = securityPin;

    peer = new Peer(fixedPeerId);

    initializePeerEvents();
}

/* ======================================
   PEER EVENTS
====================================== */

function initializePeerEvents(){

    peer.on('open',(id)=>{

        updateStatus('Waiting');

        const connectURL =

            window.location.origin +
            '?connect=' +
            encodeURIComponent(id);

        new QRCode(
            document.getElementById('qrcode'),
            {
                text:connectURL,
                width:180,
                height:180
            }
        );
    });

    peer.on('connection',(conn)=>{

        setupConnection(conn);
    });

    peer.on('error',(err)=>{

        console.log(err);

        updateStatus('Offline');

        showToast('Peer Error');
    });
}

/* ======================================
   CONNECTION
====================================== */

document.getElementById(
    'connect-btn'
).onclick = ()=>{

    const targetId =

        document.getElementById(
            'peer-id-input'
        ).value.trim();

    const pin =

        document.getElementById(
            'pin-input'
        ).value.trim();

    if(!targetId || !pin){

        return showToast(
            'Enter ID and PIN'
        );
    }

    connectToPeer(
        targetId,
        pin
    );
};

function connectToPeer(targetId,pin){

    if(targetId === fixedPeerId){

        return showToast(
            'Cannot connect to yourself'
        );
    }

    updateStatus('Connecting');

    const conn = peer.connect(
        targetId,
        {
            reliable:true
        }
    );

    conn.on('open',()=>{

        conn.send({

            type:'auth',
            pin:pin,
            senderId:fixedPeerId
        });
    });

    setupConnection(conn);
}

function setupConnection(conn){

    conn.on('data',(data)=>{

        /* AUTH */

        if(data.type === 'auth'){

            if(data.pin !== securityPin){

                conn.send({
                    type:'auth-failed'
                });

                conn.close();

                return;
            }

            conn.send({
                type:'auth-success'
            });

            connections[conn.peer] = conn;

            renderConnectedDevice(
                conn.peer
            );

            updateStatus('Connected');

            showToast(
                'Connected: ' +
                conn.peer
            );

            return;
        }

        if(data.type === 'auth-success'){

            connections[conn.peer] = conn;

            renderConnectedDevice(
                conn.peer
            );

            updateStatus('Connected');

            showToast(
                'Secure Connection Success'
            );

            return;
        }

        if(data.type === 'auth-failed'){

            showToast(
                'Wrong PIN'
            );

            conn.close();

            return;
        }

        /* FILE RECEIVE */

        if(
            data.type === 'file-chunk' ||
            data.type === 'file-complete'
        ){

            receiveFile(data);
        }
    });

    conn.on('close',()=>{

        delete connections[conn.peer];

        showToast(
            'Disconnected'
        );

        if(
            Object.keys(connections).length === 0
        ){

            updateStatus('Waiting');
        }
    });
}

/* ======================================
   FILE SEND
====================================== */

document.getElementById(
    'browse-btn'
).onclick = ()=>{

    document.getElementById(
        'file-input'
    ).click();
};

document.getElementById(
    'file-input'
).onchange = (e)=>{

    handleFiles(
        e.target.files
    );
};

function handleFiles(files){

    if(
        Object.keys(connections).length === 0
    ){

        return showToast(
            'No connected device'
        );
    }

    Array.from(files).forEach(file=>{

        const transferId =

            Math.random()
            .toString(36)
            .substring(2,9);

        addTransferUI(
            file.name,
            transferId,
            'Sending'
        );

        const chunkSize =
            64 * 1024;

        let offset = 0;

        const reader =
            new FileReader();

        reader.onload = (e)=>{

            Object.values(connections)
            .forEach(conn=>{

                conn.send({

                    type:'file-chunk',
                    name:file.name,
                    data:e.target.result,
                    offset,
                    size:file.size,
                    transferId
                });
            });

            offset +=
                e.target.result.byteLength;

            const progress =

                Math.floor(
                    (offset/file.size)*100
                );

            updateProgressUI(
                transferId,
                progress
            );

            if(offset < file.size){

                readSlice(offset);

            }else{

                Object.values(connections)
                .forEach(conn=>{

                    conn.send({

                        type:'file-complete',
                        transferId
                    });
                });

                updateProgressUI(
                    transferId,
                    100
                );

                showToast(
                    'Sent: ' +
                    file.name
                );
            }
        };

        const readSlice = (o)=>{

            reader.readAsArrayBuffer(

                file.slice(
                    o,
                    o+chunkSize
                )
            );
        };

        readSlice(0);
    });
}

/* ======================================
   FILE RECEIVE
====================================== */

function receiveFile(data){

    if(data.type === 'file-complete'){

        const fileData =
            incoming[data.transferId];

        if(!fileData) return;

        const blob =
            new Blob(fileData.chunks);

        const url =
            URL.createObjectURL(blob);

        const a =
            document.createElement('a');

        a.href = url;

        a.download =
            fileData.name;

        document.body.appendChild(a);

        a.click();

        document.body.removeChild(a);

        updateProgressUI(
            data.transferId,
            100
        );

        showToast(
            'Received: ' +
            fileData.name
        );

        delete incoming[data.transferId];

        return;
    }

    if(!incoming[data.transferId]){

        incoming[data.transferId] = {

            chunks:[],
            received:0,
            name:data.name,
            size:data.size
        };

        addTransferUI(
            data.name,
            data.transferId,
            'Receiving'
        );
    }

    incoming[data.transferId]
    .chunks.push(data.data);

    incoming[data.transferId]
    .received +=
        data.data.byteLength;

    const progress =

        Math.floor(

            (
                incoming[data.transferId]
                .received /

                incoming[data.transferId]
                .size

            ) * 100
        );

    updateProgressUI(
        data.transferId,
        progress
    );
}

/* ======================================
   UI
====================================== */

function addTransferUI(name,id,type){

    const html = `

        <div class="transfer-item"
             id="tr-${id}">

            <div>

                <strong>${name}</strong>

            </div>

            <div>

                ${type}

            </div>

            <div class="progress">

                <div class="progress-bar"
                     id="pb-${id}">
                </div>

            </div>

            <div id="txt-${id}">
                0%
            </div>

        </div>
    `;

    document.getElementById(
        'transfers'
    ).insertAdjacentHTML(
        'afterbegin',
        html
    );
}

function updateProgressUI(id,val){

    const bar =
        document.getElementById(
            `pb-${id}`
        );

    const txt =
        document.getElementById(
            `txt-${id}`
        );

    if(bar){

        bar.style.width =
            val + '%';
    }

    if(txt){

        txt.innerText =
            val + '%';
    }
}

function renderConnectedDevice(id){

    const html = `

        <div class="peer-box">

            ${id}

        </div>
    `;

    document.getElementById(
        'connected-devices'
    ).insertAdjacentHTML(
        'beforeend',
        html
    );
}

function showToast(message){

    const toast =
        document.getElementById('toast');

    document.getElementById(
        'toast-msg'
    ).innerText = message;

    toast.style.opacity = '1';

    toast.style.transform =
        'translateY(0px)';

    setTimeout(()=>{

        toast.style.opacity = '0';

        toast.style.transform =
            'translateY(20px)';

    },3000);
}

function updateStatus(text){

    document.getElementById(
        'status'
    ).innerHTML = `

        <span class="dot"></span>

        ${text}
    `;
}

/* ======================================
   DRAG DROP
====================================== */

const dropZone =
    document.getElementById(
        'drop-zone'
    );

dropZone.ondragover = (e)=>{

    e.preventDefault();

    dropZone.classList.add('active');
};

dropZone.ondragleave = ()=>{

    dropZone.classList.remove('active');
};

dropZone.ondrop = (e)=>{

    e.preventDefault();

    dropZone.classList.remove('active');

    handleFiles(
        e.dataTransfer.files
    );
};

/* ======================================
   COPY ID
====================================== */

document.getElementById(
    'copy-peer-id'
).onclick = ()=>{

    navigator.clipboard.writeText(
        fixedPeerId
    );

    showToast('ID Copied');
};
